var os             = require('os');
var util           = require('util');
var events         = require('events');
var rewire         = require('rewire');
var request        = require('request');
var soap           = require('soap');
var CdifDevice     = require('./cdif-device');
var LOG            = require('./logger');
var CdifError      = require('./cdif-error').CdifError;
var DeviceError    = require('./cdif-error').DeviceError;
var QueryDevice    = require('./query-device');
var ServiceClient  = require('./service-client');
var options        = require('./cli-options');

var async          = require('async');
var stringify      = require('json-stringify-safe');
var redis          = require("redis");
var path           = require('path');

var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;

var redisClient    = null;

//create redis client under single thread mode or main thread
if (isMainThread === true) {
  redisClient    = redis.createClient(options.redisUrl, {db: 10});

  redisClient.on('error', function (err) {
    if (options.debug !== true) LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
  });
}

module.exports = {
  // if this host run as router it may need to return its WAN IP address
  getHostIp: function() {
    if (options.bindAddr != null) return options.bindAddr;
    // if bindAddr not specified, then we bind to the first available interface, not 0.0.0.0 for security reason
    var interfaces = os.networkInterfaces();
    for (var k in interfaces) {
      for (var k2 in interfaces[k]) {
        var address = interfaces[k][k2];
          if (address.family === 'IPv4' && !address.internal) {
            // only return the first available IP
            return address.address;
          }
      }
    }
  },
  getHostProtocol: function() {
    // in production return https instead
    return 'http://';
  },

  inherits: function(constructor, superConstructor) {
    util.inherits(constructor, superConstructor);

    // prevent child override
    if (superConstructor === CdifDevice) {
      for (var i in superConstructor.prototype) {
        constructor.prototype[i] = superConstructor.prototype[i];
      }
    }
  },
  //TODO: loadFile cannot handle relative path for now, use https://www.npmjs.com/package/callsites to get caller's file path and
  // based on that information, parse the relative path name in it
  loadFile: function(name) {
    // avoid entering global require cache
    // to be used by device modules to reload its impl. files on module reload
    // name must be absolute path to the files
    if (options.debug === true) {
      return rewire(path.resolve(name));
    }

    var loadedFile = rewire(path.resolve(name));
    if (loadedFile.__set__ == null) return loadedFile;

    // drop console under release mode, according to node.js v10.6 document
    loadedFile.__set__({
      console: {
        assert:         function() {},
        clear:          function() {},
        count:          function() {},
        countReset:     function() {},
        debug:          function() {},
        dir:            function() {},
        dirxml:         function() {},
        error:          function() {},
        group:          function() {},
        groupCollapsed: function() {},
        groupEnd:       function() {},
        info:           function() {},
        log:            function() {},
        table:          function() {},
        time:           function() {},
        timeEnd:        function() {},
        trace:          function() {},
        warn:           function() {}
      },
      __instrument__: {
        isAlive: function(callback) {
          process.nextTick(function() {
            return callback();
          });
        }
      }
    });

    return loadedFile;
  },
  request: function(opts, callback) {
    //wrapper for request, https://www.npmjs.com/package/request
    request(opts, callback);
  },
  createSOAPClient: function(url, opts, callback) {
    //wrapper for SOAP client, https://www.npmjs.com/package/soap
    soap.createClient(url, opts, callback);
  },
  invokeAction: function(userKey, deviceBaseUrl, serviceID, actionName, args, callback) {
    // convenience method to invoke a CDIF action
    if (deviceBaseUrl == null || typeof(deviceBaseUrl) !== 'string') return callback(new Error('invalid device base url'));
    if (typeof(args) !== 'object') return callback(new Error('must specify input argument'));

    var opts = {
      url: deviceBaseUrl + '/invoke-action',
      headers: {
        'X-Apemesh-Key': userKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json;charset=utf-8',
      },
      method: 'POST',
      json: {
        serviceID:  serviceID,
        actionName: actionName,
        input: args.input
      }
    };

    this.request(opts, function(error, response, body) {
      if (error != null) {
        return callback(error, null);
      }
      if (response.statusCode > 200) {
        return callback(new Error(body.message), null);
      }
      //body contain parsed JSON data with output field in it
      return callback(null, body);
    });
  },
  //FIXME: under debug mode do not query remote server if device module is creating a service client for himself
  //instead we should follow the non-debug mode path
  createServiceClient: function(opts, callback) {
    var deviceID  = opts.deviceID;
    var serviceID = opts.serviceID;
    var session   = opts.ctx;       // ctx may be passed into device modules as part of the args

    if (typeof(callback) !== 'function') return;

    //appKey should exist for security reason
    if (opts.appKey == null && opts.ctx == null) return callback(new Error('must specify appKey or ctx object'), null);
    if (deviceID == null || serviceID == null || typeof(deviceID) !== 'string' || typeof(serviceID) !== 'string') return callback(new Error('must specify deviceID and serviceID'), null);

    //if both are present, appKey should have precendence over ctx
    var appKey = (opts.appKey != null) ? opts.appKey : session.appKey;
    //under debug mode we query remote server, e.g. api.apemesh.com:3049/device-list to get the serviceID
    //this means under debug mode we will query remote portal even user create a service client for himself
    if (options.debug === true && options.verifyModule === true) {
      var deviceListOpts = {
        url: options.centralPortalUrl + '/device-list',
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Apemesh-Key': appKey
        }
      };
      //TODO: add request timeout support
      request(deviceListOpts, function(err, response, body) {
        var info = null;
        if (err != null) return callback(err, null);
        try {
          info = JSON.parse(body);
        } catch (e) {
          return callback(e, null);
        }
        if (response.statusCode > 200) return callback(new Error(info.message), null); // user not found or other error from device-list call

        var targetService = null;
        async.each(info, function(item, cb) {
          if (item.device.deviceID === deviceID) {
            var getDeviceSpecOpts = {
              url: options.centralPortalUrl + '/devices/' + item.device.deviceID + '/get-spec',
              method: 'GET',
              headers: {
                'Content-Type': 'application/json',
                'X-Apemesh-Key': appKey
              }
            };
            //TODO: add request timeout support
            request(getDeviceSpecOpts, function(err, resp, body) {
              var spec = null;
              if (err != null) {
                return cb(err);
              }
              try {
                spec = JSON.parse(body);
              } catch (e) {
                return cb(e);
              }
              if (resp.statusCode > 200) return cb(new Error(spec.message), null);

              var serviceList = spec.device.serviceList;
              var found = false;
              for (var id in serviceList) {
                if (id === serviceID) found = true;
              }
              if (found === true) {
                targetService = new ServiceClient(null, true, false, appKey, deviceID, serviceID);
                targetService.deviceBaseUrl = options.centralPortalUrl + '/devices/' + item.device.deviceID;
                return cb();
              }
              return cb(new Error('查找服务失败，应用内无对应服务'));
            });
          } else {
            return cb();
          }
        }, function(err) {
          if (err != null) {
            return callback(err, null);
          }
          if (targetService == null) {
            return callback(new Error('查找服务失败，未知应用'));
          }
          return callback(null, targetService);
        });
      });
    } else {
      // under non-debug mode we query local instance to find the service
      var queryDeviceObj = new QueryDevice(appKey, this.ci, deviceID, serviceID, callback);

      if (options.workerThread !== true && isMainThread === true) {
        //non worker thread mode
        this.dm.emit('querydevice', deviceID, queryDeviceObj.callback);
      } else if (options.workerThread !== true && isMainThread === false) {
        //worker thread mode and running in child thread
        // see 'query-device-reply' message handler in app-sandbox and callback def in query-device.js
        // callback receives err and spec and return
        var wm = this.dm.workerMessage;
        if (wm != null) wm.sendDeviceQueryMessageToParent(deviceID, queryDeviceObj.callback);
      } else {
        //worker thread mode and running in main thread
        return callback(new Error('查找服务失败：禁止在主线程中查找'));
      }

    }
  },

  deviceLog: function(device, entry) {
    if (!(device instanceof CdifDevice)) return;

    var deviceID = device.deviceID;
    if (deviceID  == null || deviceID === '') return;

    var data = null;
    if (typeof(entry) === 'object' || Array.isArray(entry)) {
      data = stringify(entry);
    } else {
      data = entry;
    }

    if (options.debug === true) return console.log(data);

    if (isMainThread === true) {
      redisClient.multi()
      .lpush('devicelog:' + deviceID, data)
      .lpush('devicelogtimestamp:' + deviceID, Date.now())
      .ltrim('devicelog:' + deviceID, 0, options.deviceLogEntrySize)
      .ltrim('devicelogtimestamp:' + deviceID, 0, options.deviceLogEntrySize)
      .exec(function(e, reply) {
        if (e) LOG.E(e);
      });
    } else {
      var wm = this.dm.workerMessage;
      if (wm != null) {
        wm.sendDeviceLogMessageToParent(deviceID, data, Date.now(), function(e) {
          if (e) LOG.E(e);
        });
      }
    }
  },

  // this call is used by framework to do deviceLog in mainthread under worker-thread mode, normally it should not be exposed to external caller
  __deviceLogWithID: function(deviceID, entry, timestamp, callback) {
    if (deviceID  == null || deviceID === '') return;

    var data = null;
    if (typeof(entry) === 'object' || Array.isArray(entry)) {
      data = stringify(entry);
    } else {
      data = entry;
    }

    if (options.debug === true) return console.log(data);

    if (isMainThread === true) {
      redisClient.multi()
      .lpush('devicelog:' + deviceID, data)
      .lpush('devicelogtimestamp:' + deviceID, timestamp)
      .ltrim('devicelog:' + deviceID, 0, options.deviceLogEntrySize)
      .ltrim('devicelogtimestamp:' + deviceID, 0, options.deviceLogEntrySize)
      .exec(function(e, reply) {
        return callback(e);
      });
    } else {
      return callback(new Error('this should be called from main thread'));
    }
  },
  //TODO: add message broadcast support,
  // such as: broadCastMessage(data);

  redis: null,  //this reference is set in sandbox.js / framework.js

  jobProgress: function(jobID, progress) {
    // non worker mode
    if (options.workerThread !== true && isMainThread === true) return;

    if (typeof(jobID) !== 'string' && typeof(jobID) !== 'number') return;
    if (typeof(progress) !== 'number') return;
    if (progress < 0 || progress > 100) return;

    //worker thread mode and running in child thread
    if (options.workerThread !== true && isMainThread === false) {
      var wm = this.dm.workerMessage;
      if (wm != null) wm.sendJobProgressMessageToParent({jobID: jobID, progress: progress});
    }
  },

  jobInfo: function(jobID, callback) {
    if (isMainThread === true) return callback(new Error('cannot work in main thread and single-thread mode'));

    if (typeof(jobID) !== 'string' && typeof(jobID) !== 'number') return callback(new Error('invalid jobID: ' + jobID + '. must be string or number type'));

    //worker thread mode and running in child thread
    var wm = this.dm.workerMessage;

    if (wm != null) {
      return wm.sendGetJobInfoMessageToParent(jobID, function(e, job) {
        if (e) LOG.E(e);
        return callback(e, job);
      });
    }

    return callback(new Error('unknown worker thread'));
  }
};
