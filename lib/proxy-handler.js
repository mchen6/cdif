var proxy       = require('express-http-proxy');
var options     = require('./cli-options');
var nano        = require('nano')(options.dbUrl);
var LOG         = require('./logger');
var redis       = require("redis");
var redisClient = redis.createClient(options.redisUrl);

redisClient.on('error', function (err) {
  if (options.isDebug !== true) LOG.E(new CdifError('REDIS_CLIENT_ERROR', err.message));
});

var apiProxyDB = nano.db.use('api-proxy-device');


var filterFunction = function(req, res) {
  if (options.enableAPIMonitor === true) {
    var appKey   = req.session.appKey;
    var deviceID = req.session.deviceID;
    var now      = Date.now();

    var apiChannel = appKey + '#' + deviceID + '#' + 'service' + '#' + 'api';

    redisClient.multi()
    .sadd('nightlyset', apiChannel)
    .rpush('starttime:' + apiChannel, now)
    .rpush('list:' + apiChannel, now)
    .rpush('isError:' + apiChannel, false)
    .rpush('isHTTP:' + apiChannel, true)
    .exec(function(e, reply) {
      if (e) LOG.E(e);
    });
  }
  return true;
};

module.exports = {
  proxyMap: {},
  app: null,

  loadProxyHost: function(deviceID, target) {
    if (deviceID == null || typeof(deviceID) !== 'string') return;

    if (this.proxyMap[deviceID] == null) {
      if (this.app != null) {
        this.app.use('/api-proxy/' + deviceID, proxy(this.getProxyHost.bind(this, deviceID), {
          parseReqBody: false,
          limit: '1gb',
          timeout: 60000,
          memoizeHost: true,
          filter: filterFunction
        }));
      } else {
        return; //do not add target to map if app route not installed
      }
    }
    this.proxyMap[deviceID] = target;
  },

  loadAllProxyHosts: function(callback) {
    apiProxyDB.view('api-proxy-device', 'getAll', {}, function(err, doc) {
      if (err) return callback(err);

      for (var i = 0; i < doc.rows.length; i++) {
        this.proxyMap[doc.rows[i].key] = doc.rows[i].value;
      }
      return callback(null);
    }.bind(this));
  },

  getProxyHost: function(deviceID) {
    // LOG.I('deviceID: ' + deviceID + ' to target: ' + this.proxyMap[deviceID] + ' is proxied');
    return this.proxyMap[deviceID];
  },

  installProxyRoutes: function(app) {
    if (this.app == null) this.app = app;

    for (var deviceID in this.proxyMap) {
      this.app.use('/api-proxy/' + deviceID, proxy(this.getProxyHost.bind(this, deviceID), {
        parseReqBody: false,
        limit: '1gb',
        timeout: 60000,
        memoizeHost: true,
        filter: filterFunction
      }));
    }
  }
}