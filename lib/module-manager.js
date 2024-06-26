var events         = require('events');
var util           = require('util');
var CdifUtil       = require('../lib/cdif-util');
var options        = require('../lib/cli-options');
var exec           = require('child_process').exec;
var CdifError      = require('../lib/cdif-error').CdifError;
var LOG            = require('../lib/logger');
var C9Launcher     = require('../lib/c9-launcher');
var VSCodeLauncher = require('../lib/vscode-launcher');

var getDeviceConfig = require('./device-config');

var rewire      = require('rewire');
var semver      = require('semver');
var mkdirp      = require('mkdirp');
var rimraf      = require('rimraf');
var fs          = require('fs');
var chmodr      = require('chmodr');
var Domain      = require('domain');
var async       = require('async');
var path        = require('path');
var _           = require('lodash');
var fse         = require('fs-extra');

var Worker         = require('worker_threads').Worker;
var isMainThread   = require('worker_threads').isMainThread;
var WorkerMessage  = require('./worker-message');

function ModuleManager() {
  this.modules = {};
  this.noofTotalModules = 0;
  // this.noofAvailableModules = 0;
  this.noofLoadedModules = 0;

  this.on('moduleload', this.onModuleLoad.bind(this));
  this.on('moduleunload', this.onModuleUnload.bind(this));

  if (options.vscode === true) VSCodeLauncher.init(this, options.dbUrl);

  // special event handler to get the list of devices under a module instance
  // this event is emmited by device manager and is only active when verify
  // package route is enabled
  this.on('querydevicelistresult', this.onQueryDeviceListResult.bind(this));
}

util.inherits(ModuleManager, events.EventEmitter);

//get the list of devices owned by module name
ModuleManager.prototype.getModuleDeviceListByName = function(name, callback) {
  var moduleInstance = this.modules[name];
  if (moduleInstance == null) return callback(new Error('unknown module name'), null);

  //HACK: the handler is not interested with packageInfo so we pass it just an empty object here
  //this is to make onQueryDeviceListResult() happy
  this.emit('querydevicelist', moduleInstance, {name: name}, callback); //we only interested at deviceList in the callbacked object
}

ModuleManager.prototype.onModuleLoad = function(name, module, version) {
  //only print this in child thread when a module is truly loaded, or when worker thread mode is disabled
  if (options.workerThread !== true || !isMainThread) LOG.I('module: ' + name + '@' + version + ' loaded');

  module.discoverState = 'stopped';

  var m = this.modules[name];
  if (m != null) {
    // module reloaded
    if (m.discoverState === 'discovering') {
      m.discoverState = 'stopped';
    }
    this.emit('purgedevice', m, 'MODULE RELOADED', function() {
      this.modules[name] = module;
    }.bind(this)); // to be handled by device manager
  } else {
    this.modules[name] = module;
  }


  var _mm = this;

  if (options.allowDiscover === true && options.workerThread === true) {
    //TODO: manually send discover event to worker start from route-manager
    LOG.E('we do not support emit discover events in main thread yet');
    return;
  }

  if (options.allowDiscover === false) {
    if (options.workerThread === true && isMainThread === true) {
      //worker thread mode and run in main thread
      _mm.emit('modulediscovering');

      module.discoverState = 'discovering';

      module.sendDiscoverMessage({}, function() {
        module.discoverState = 'stopped';

        if (_mm.modules[name] != null) {
          _mm.noofLoadedModules ++;

          if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules > _mm.noofTotalModules) {
            // this can happen if we reload an existing module and resend discover message
            _mm.noofLoadedModules = _mm.noofTotalModules;
          }
          if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules === _mm.noofTotalModules) {
            LOG.I('all module discovered');
            _mm.emit('allmodulediscovered');
            if (options.withPM2 === true) process.send('ready');   // send ready event to ccl
          }
        }
      });
    } else if (options.workerThread === false && isMainThread === true) {
      //non worker-thread mode
      _mm.emit('modulediscovering'); //is this event garenteed handled before next event?

      module.emit('discover');
      module.discoverState = 'discovering';

      setTimeout(function() {
        this.emit('stopdiscover');
        this.discoverState = 'stopped';

        _mm.noofLoadedModules ++;
        // if an independent module is loaded during run time, noofLoadedModules would be larger than noofTotalModules
        // in this case we emit allmodulesloaded event again to let device manager cleanup remaining notifyDeviceLoad callbacks if any
        // this allows createServiceClient to be called at any place in the user code at any time
        if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules > _mm.noofTotalModules) {
          // this can happen if we reload an existing module and resend discover message
          _mm.noofLoadedModules = _mm.noofTotalModules;
        }

        if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules === _mm.noofTotalModules) {
          LOG.I('all module discovered');
          _mm.emit('allmodulediscovered');
          if (options.withPM2 === true) process.send('ready');   // send ready event to ccl
        }
      }.bind(module), 5000);
    } else {
      //worker thread mode but run in child thread, this is handled by discoverAllDevices call below
      // because we send discover event to child thread from main thread, see above
    }
  }
};

ModuleManager.prototype.onModuleUnload = function(name, reason, callback) {
  LOG.I('module: ' + name + ' unloaded due to reason: ' + reason);

  var m = this.modules[name];
  if (m == null) {
    if (callback != null && typeof(callback) === 'function') return callback();
  }

  if (m.discoverState === 'discovering') {
    m.discoverState = 'stopped';
  }

  this.emit('purgedevice', m, reason, function() {
    delete this.modules[name];
    if (callback != null && typeof(callback) === 'function') callback();
  }.bind(this));
};

ModuleManager.prototype.discoverAllDevices = function() {
  if (options.workerThread === false && isMainThread === true) this.emit('modulediscovering');
  for (var m in this.modules) {
    var module = this.modules[m];
    if (module.discoverState === 'discovering') {
      return;
    }
    module.emit('discover');
    module.discoverState = 'discovering';
  }
};

ModuleManager.prototype.stopDiscoverAllDevices = function() {
  if (options.workerThread === false && isMainThread === true) this.emit('allmodulediscovered');
  for (var m in this.modules) {
    var module = this.modules[m];
    if (module.discoverState === 'stopped') {
      return;
    }
    module.emit('stopdiscover');
    module.discoverState = 'stopped';
  }
};

ModuleManager.prototype.onDeviceOnline = function(packageInfo, modulePath, device, module) {
  var found = false;
  for (var moduleName in this.modules) {
    if (this.modules[moduleName] === module) {
      found = true;
      this.emit('deviceonline', device, module, moduleName, packageInfo, modulePath);
    }
  }
  if (found === false) {
    LOG.E(new CdifError('CORRESPONDING_MODULE_NOT_FOUND', 'device online'));
  }
};

ModuleManager.prototype.onDeviceOffline = function(device, module) {
  var found = false;

  for (var moduleName in this.modules) {
    if (this.modules[moduleName] === module) {
      found = true;
      this.emit('deviceoffline', device, module, moduleName);
    }
  }
  if (found === false) {
    LOG.E(new CdifError('CORRESPONDING_MODULE_NOT_FOUND', 'device offline'));
  }
};

ModuleManager.prototype.getModuleInfoFromPath = function(pathList) {
  var list = [];

  if (typeof(pathList) === 'string') {
    list.push(pathList);
  } else if (Array.isArray(pathList)) {
    list = pathList;
  } else {
    LOG.E(new CdifError('LOAD_MODULE_FAIL', 'invalid loadModule argument:', pathList));
    return null;
  }

  var info = [];

  list.forEach(function(item) {
    if (fs.existsSync(item) && fs.existsSync(item + '/package.json')) {
      try {
        var packageInfo = JSON.parse(fs.readFileSync(item + '/package.json').toString());
        info.push({path: item, name: packageInfo.name, version: packageInfo.version});
      } catch (e) {
        LOG.E(new CdifError('LOAD_MODULE_FAIL', 'invalid package.json file:', item));
      }
    } else {
      LOG.E(new CdifError('LOAD_MODULE_FAIL', 'invalid path or package.json file not found:', item));
    }
  });
  return info;
};

// This function is only run in main thread
// to load a local module specified by --loadModule CLI option
// or load all modules according to sqlite db info
ModuleManager.prototype.loadAllModules = function() {
  var _this = this;
  var _mm   = this;

  // in case loading local module, we won't read module info from DB, instead read its info from package.json
  if (options.localModulePath != null) {
    var info = this.getModuleInfoFromPath(options.localModulePath);
    if (info == null) return;

    this.noofTotalModules = info.length;

    async.eachSeries(info, function(item, cb) {
      _this.loadModuleFromPath(item.path, item.name, item.version, function(err, mi) {
        LOG.I('load local module from path: ' + item.path);

        if (err != null) {
          _mm.noofLoadedModules ++;

          if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules > _mm.noofTotalModules) {
            _mm.noofLoadedModules = _mm.noofTotalModules;
          }
          if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules === _mm.noofTotalModules) {
            LOG.I('all module discovered');
            _mm.emit('allmodulediscovered');
            if (options.withPM2 === true) process.send('ready');   // send ready event to ccl
          }
        }
        return cb();
      });
    }, function(e) {

    });

    return;
  }

  if (options.workerThread !== true || isMainThread === true) {
    //do not require sqlite3 which contains native bindings in child thread
    var deviceDB = require('@apemesh/cdif-device-db');
    deviceDB.getAllModuleInfo(function(err, data) {
      if (err) {
        return LOG.E(new CdifError('GET_MODULE_INFO_FAIL', err.message));
      }

      if (data == null) return;

      this.noofTotalModules = data.length;

      if (this.noofTotalModules === 0) {
        if (options.withPM2 === true) process.send('ready');   // send ready event to ccl
      }

      async.eachSeries(data, function(item, cb) {
        _this.loadModuleFromPath(item.path, item.name, item.version, function(err, mi) {
          // in case of load fail (exception catched during rewire()), we increase noofLoadedModules
          // so we don't block 'allmoduleloaded' event emission after all module loaded
          // in normal case where no exceptions occured, noofLoadedModules increment is done after discover message is delivered
          // which indicates module is successfully loaded
          if (err != null) {
            _mm.noofLoadedModules ++;

            if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules > _mm.noofTotalModules) {
              _mm.noofLoadedModules = _mm.noofTotalModules;
            }
            if (_mm.noofTotalModules > 0 && _mm.noofLoadedModules === _mm.noofTotalModules) {
              LOG.I('all module discovered');
              _mm.emit('allmodulediscovered');
              if (options.withPM2 === true) process.send('ready');   // send ready event to ccl
            }
          }
          return cb();
        });
      }, function(err) {
        // _this.noofTotalModules = _this.noofAvailableModules;
      });
    }.bind(this));
  }
};

//this is a sync call if not enabled worker thread
//TODO: load module from existing thread if already existed
ModuleManager.prototype.loadModuleFromPath = function(modulePath, name, version, callback) {
  if (options.workerThread === true && isMainThread === true) {
    return this.loadModuleByWorker(modulePath, name, version, function(err, mi) {
      // if (err) LOG.E(new CdifError('LOAD_MODULE_FAIL', err.message));

      return callback(err, mi);
    });
  }

  var moduleConstructor = null;
  var moduleInstance    = null;
  var packageInfo       = null;

  if (typeof(modulePath) !== 'string' || !fs.existsSync(modulePath)) return callback(new CdifError('INVALID_MODULE_PATH', modulePath));

  try {
    packageInfo = JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json')).toString());
    moduleConstructor = rewire(path.resolve(modulePath));  //resolve relative path to absolute since rewire cant handle it
    //TODO: support loading 3rd party npm packages and publish them to our own registry
    //this would allow user publish and use a missing npm package in closed network environment
    moduleInstance    = new moduleConstructor();
  } catch (e) {
    LOG.E(new CdifError('LOAD_MODULE_FAIL', name, e.message, e.stack));
    return callback(e);
  }

  moduleInstance.on('deviceonline',  this.onDeviceOnline.bind(this, packageInfo, modulePath));  //append content of package.json and modulePath to module instance
  moduleInstance.on('deviceoffline', this.onDeviceOffline.bind(this));

  // Access CouchDB to load device specific configuration data
  getDeviceConfig(options, name, function(err) {
    if (err) LOG.E(new CdifError('DEVICE_CONFIG_LOAD_FAIL', err.message));

    this.emit('moduleload', name, moduleInstance, version);
    return callback(null, moduleInstance);
  }.bind(this));
};

//TODO: if module load failed, terminate the child thread
// this call always run in main thread
ModuleManager.prototype.loadModuleByWorker = function(modulePath, name, version, callback) {
  var wm = this.modules[name];

  if (wm != null) {
    //module reload
    wm.sendLoadModuleMessage({path: modulePath, name: name, version: version}, function(e, d) {
      if (e) {
        //this can happen if module load fail caused by errors in device modules such as code syntax error etc.
        this.unloadModule(name, 'WORKER LOAD MODULE FAIL: ' + e.message, function() {
          wm.worker.terminate();
          return callback(e, d);
        });
      } else {
        this.emit('moduleload', name, wm, version);
        return callback(null, wm);
      }
    }.bind(this));
  } else {
    var worker = new Worker(__dirname + '/sandbox.js'); //this is the name under release mode

    worker.on('error', function(err) {
      // in case of uncaught exception, work will exit here, we should clean up it
      LOG.E(new Error('worker exit on error: ' + err.message));
      this.unloadModule(name, 'ERROR MESSAGE FROM WORKER: ' + err.message, function() {});
    }.bind(this));

    worker.on('exit', function(exitCode) {
      // in case of uncaught exception, work will exit here, we should clean up it
      LOG.E(new Error('worker exit with code: ' + exitCode));
      this.unloadModule(name, 'WORKER EXIT WITH CODE: ' + exitCode, function() {});
    }.bind(this));


    var workerMessage = new WorkerMessage(worker);

    if (workerMessage == null) {
      return callback(new Error('spawn worker failed'));
    }

    workerMessage.sendSetOptionsMessage({options: options.getOptions()}, function(err, data) {
      if (err) {
        worker.terminate();
        return callback(err, data);
      }
      workerMessage.sendLoadModuleMessage({path: modulePath, name: name, version: version}, function(e, d) {
        if (e) {
          worker.terminate();
          return callback(e, d);
        }
        this.emit('workerloaded', workerMessage);
        //workerMessage also acting as moduleInstance in main thread
        this.emit('moduleload', name, workerMessage, version);
        return callback(null, workerMessage);
      }.bind(this));
    }.bind(this));
  }
};

//this call MUST NOT run under worker thread mode
ModuleManager.prototype.reloadModule = function(modulePath, callback) {
  var moduleConstructor = null;
  var moduleInstance    = null;
  var packageInfo       = null;
  var name    = null;
  var version = null;

  if (typeof(modulePath) !== 'string' || !fs.existsSync(modulePath)) return callback(new CdifError('INVALID_MODULE_PATH', modulePath));

  try {
    packageInfo = JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json')).toString());
    name    = packageInfo.name;
    version = packageInfo.version;

    if (typeof(name) !== 'string') {
      return callback(new CdifError('MODULE_PACKAGE_NAME_TYPE_ERROR', name));
    }
    if (typeof(version) !== 'string' || semver.valid(version) == null) {
      // in case of any error, unload the module so user must fix coding errors before he can continue to use this module
      this.unloadModule(name, 'RELOAD MODULE FAIL DUE TO INVALID VERSION STRING', function() {
        return callback(new CdifError('MODULE_VERSION_INFO_INVALID', version));
      });
    }

    moduleConstructor = rewire(path.resolve(modulePath));  //resolve relative path to absolute since rewire cant handle it
    moduleInstance    = new moduleConstructor();

    moduleInstance.on('deviceonline',  this.onDeviceOnline.bind(this, packageInfo, modulePath)); //append content of package.json and modulePath to module instance
    moduleInstance.on('deviceoffline', this.onDeviceOffline.bind(this));

    // if there is no error, new module and devices instances inside it will be replaced in device manager
    this.emit('moduleload', name, moduleInstance, version);

    setTimeout(function() {
      //get the list of device objects which belongs to moduleInstance
      //this event is handled by device manager
      this.emit('querydevicelist', moduleInstance, packageInfo, callback);
    }.bind(this), 1000);
  } catch (e) {
    this.unloadModule(name, 'RELOAD MODULE FAIL DUE TO EXCEPTION: ' + e.message, function() {
      return callback(new CdifError('LOAD_MODULE_FAIL', e.message, e.stack));
    });
  }
};

//this should only be available under worker mode to restart a worker thread,
// and non worker mode has no such concept of 'restart', only reload a module
// and return the newly discovered device list to caller
ModuleManager.prototype.restartModule = function(modulePath, name, version, callback) {
  var m = this.modules[name];
  if (m == null) {
    return callback(new CdifError('RESTART_MODULE_FAIL', 'unknown module', name));
  }

  if (options.workerThread !== true || isMainThread !== true) {
    return this.loadModuleFromPath(modulePath, name, version, callback);
  }

  this.unloadModuleExternal(name, function() {
    this.loadModuleByWorker(modulePath, name, version, function(err, mi) {
      if (err) LOG.E(new CdifError('LOAD_MODULE_FAIL', err.message));
      return callback(err, mi);
    });
  }.bind(this));
};

ModuleManager.prototype.unloadModuleExternal = function(name, callback) {
  var m = this.modules[name];
  if (m != null) {
    if (m instanceof WorkerMessage) {
      //worker thread mode
      //first send message to child to allow child run destroyDevice call
      //then invoke unloadModule in main thread to clean workerMessage instances saved in deviceMap
      //TODO: setTimeout and if unload message didn't get responded (possibly due to blocked by module's code), we force terminate its thread
      //TODO: deny any external API call goes into child thread before terminate the thread to be safer

      m.sendUnloadModuleMessage({name: name}, function() {});

      // to prevent device is blocked by user code, terminate thread and return after 3 seconds
      setTimeout(function() {
        if (this.modules[name] != null) {
          this.unloadModule(name, 'CLEANUP MODULE INFO IN MAIN THREAD', function() {
            m.worker.terminate();
            return callback();
          });
        }
      }.bind(this), 3000);
    } else {
      //single thread mode
      if (isMainThread === true) return this.unloadModule(name, 'UNLOAD MODULE IN MAIN THREAD', callback);
      //do unload in child thread
      return this.unloadModule(name, 'UNLOAD MODULE IN WORKER', callback);
    }
  }
};

//when called in main thread, this cleans workerMessage instances saved in deviceMap
//when called in child thread, this cleans device object saved in deviceMap

// Note that under worker thread mode, unloadModule() call is ALWAYS initiated
// from main thread by sending module-unload to worker, but it also run in child
// thread to clean up the deviceMap in it
// the reason system calling this method can be either:
// 1. user initiated module unload from unloadModuleExternal()
// 2. worker thread exit / error exception caught by main thread
// 3. load module fail on worker start up
ModuleManager.prototype.unloadModule = function(name, reason, callback) {
  var m = this.modules[name];

  if (m != null) return this.emit('moduleunload', name, reason, callback);

  return callback();
};

ModuleManager.prototype.verifyModule = function(input, callback) {
  var registry = input.registry;
  if (typeof(registry) !== 'string') {
    registry = options.regUrl; //fall back to default registry url
  }

  if (typeof(input.name) !== 'string') {
    return callback(new CdifError('MODULE_NAME_TYPE_ERROR', input.name));
  }
  if (input.path == null || typeof(input.path) !== 'string') {
    return callback(new CdifError('MODULE_INSTALL_PATH_PREFIX_INVALID'));
  }

  var _this     = this;
  var zlib      = require('zlib');
  var tar       = require('tar');
  var stream    = require('stream');
  var errorInfo = null;

  var installBasePath, modulePath, packageInfo, name, version;  // these variables are assigned in package.json parse code and used on parsing end

  var apiJson, schemaJson;

  var fileBuffer = {};

  var doFreshNPMInstall = true, schemaJsonMatches = false, apiJsonMatches = false, packageJsonMatches = false;

  var file = fs.createReadStream(input.name);
  file.on('error', function(e) {
    return callback(new CdifError('READ_MODULE_FAIL', e.message));
  });

  var unzip = file.pipe(zlib.Unzip());
  unzip.on('error', function(e) {
    return callback(new CdifError('UNZIP_MODULE_FAIL', e.message));
  });

  var tar = unzip.pipe(tar.Parse());
  tar.on('error', function(e) {
    return callback(new CdifError('UNTAR_MODULE_FAIL', e.message));
  });

  tar.on('end', function() {
    try {
      packageInfo = JSON.parse(fileBuffer['package.json'].toString());
      apiJson     = JSON.parse(fileBuffer['api.json'].toString());
      schemaJson  = JSON.parse(fileBuffer['schema.json'].toString());
    } catch (e) {
      return callback(new CdifError('MODULE_INSTALL_FAIL', e.message));
    }

    if (typeof(packageInfo) !== 'object') {
      return callback(new CdifError('MODULE_PACKAGE_INFO_TYPE_ERROR'));
    }
    name    = packageInfo.name;
    version = packageInfo.version;

    if (name == null || version == null) {
      return callback(new CdifError('MODULE_PACKAGE_INFO_TYPE_ERROR'));
    }

    installBasePath = path.join(input.path, name);
    modulePath = installBasePath;



    // under vscode mode, any file change is synced to couchdb realtime and module install location is persisted across sessions,
    // so if this module is installed before, then we don't need to do npm install again, instead we load module from this installBasePath directly
    // this has a side effect that, if two different apiDesignID has same installBasePath (which happened when we export the same module to edit twice or more)
    // we won't be able to overwrite the old one, consider fix this by writing apiDesignID to a hidden file under working dir so we can check it
    if (options.vscode === true && fs.existsSync(modulePath)) {
      if (fs.existsSync(path.join(modulePath, 'api.json'))) {
        var storedApiJson = JSON.parse(fs.readFileSync(path.join(modulePath, 'api.json')));
        if (_.isEqual(storedApiJson, apiJson)) apiJsonMatches = true;
      }
      if (fs.existsSync(path.join(modulePath, 'schema.json'))) {
        var storedSchemaJson = JSON.parse(fs.readFileSync(path.join(modulePath, 'schema.json')));
        if (_.isEqual(storedSchemaJson, schemaJson)) schemaJsonMatches = true;
      }
      if (fs.existsSync(path.join(modulePath, 'package.json'))) {
        var storedPackageInfo = JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json')));
        if (_.isEqual(storedPackageInfo, packageInfo)) packageJsonMatches = true;
      }

      try {
        var savedDesignID = fs.readFileSync(path.join(modulePath, '.appid'), 'utf8');
        if (savedDesignID === input.apiDesignID) {
          // //check if the input packageInfo matches the one in modulePath because user may add dep, change module name etc. on web site
          if (schemaJsonMatches === true && apiJsonMatches === true && packageJsonMatches) doFreshNPMInstall = false;
        }
      } catch(e) {
        doFreshNPMInstall = true;
      }
    }

    if (options.vscode === true) {
      VSCodeLauncher.unwatchFSChange();
    }

    if (doFreshNPMInstall === false) {
      LOG.I('load module from persisted location');
      //in this case, we no longer do npm install to packed temporary package file which is written from database
      return _this.loadModuleUnsafe(modulePath, name, version, packageInfo, input.apiDesignID, callback);
    }

    mkdirp.sync(installBasePath, {mode: 0666});

    // write file contents to modulePath and install dependent packages
    for (var fileName in fileBuffer) {
      var fileContent = fileBuffer[fileName];
      var absolutePath = path.join(installBasePath, fileName);
      fse.outputFileSync(absolutePath, fileContent);
    }

    var command = 'cd ' + installBasePath + ' && npm install ' + '--registry=' + registry;

    try {
      fs.accessSync(input.path, fs.W_OK);

      exec(command, {timeout: 120000}, function(err, stdout, stderr) {
        if (err) {
          //TODO: in case of npm install error, rimraf the created module folder
          console.error('dependent module install failed: ' + err.message);
        }
        if (options.vscode === true) {
          fs.writeFileSync(path.join(modulePath, '.appid'), input.apiDesignID, 'utf8');
        }
        _this.loadModuleUnsafe(modulePath, name, version, packageInfo, input.apiDesignID, callback);
      });
    } catch (e) {
      return callback(new CdifError('MODULE_INSTALL_FAIL', e.message));
    }
  });

  tar.on('entry', function(entry) {
    if (entry.type === 'Directory') return;  // this package is created by `npm pack`, and it won't create empty folder, so we write file only, and safely skip creating directory entries
    if (entry.path == null || entry.path.startsWith('package/') === false) {
      return console.log('errored file name found in package: ' + entry.path);
    }

    var fileName = entry.path.replace(/^package\//,'');  //remove leading 'package/' from npm packed package

    var bufferStream = new stream.PassThrough();
    var data = Buffer.alloc(0);
    bufferStream.on('data', function(chunk) {
      data = Buffer.concat([data, chunk]);
    }).on('end', function() {
      fileBuffer[fileName] = data;
    }).on('error', function(err) {
      console.error('file entry: ' + entry.path + ' pipe failed: ' + err.message);
      fileBuffer[fileName] = undefined;
    });

    entry.pipe(bufferStream);
  });
};

ModuleManager.prototype.loadModuleUnsafe = function(modulePath, name, version, packageInfo, apiDesignID, callback) {
  var _this = this;
  var moduleInstance = null;

  // use domain here to catch and report error info in module's device obj constructor code
  var unsafeDomain = Domain.create();
  unsafeDomain.on('error', function(err) {
    return callback(new CdifError('MODULE_INSTALL_FAIL', err.stack), {packageInfo: packageInfo, deviceList: [], moduleInstallPath: modulePath});
  });

  if (options.cloud9 === true) {
    C9Launcher.startCloud9(modulePath, CdifUtil.getHostIp(), options.dbUrl, apiDesignID, function(errr) {
      if (errr) return callback(new CdifError('MODULE_INSTALL_FAIL', errr.message));
      unsafeDomain.run(function() { _this.loadModuleAndQueryDevice(modulePath, name, version, packageInfo, callback); });
    });
  } else if (options.vscode === true) {
    VSCodeLauncher.startVSCode(modulePath, apiDesignID, function(errr) {
      if (errr) return callback(new CdifError('MODULE_INSTALL_FAIL', errr.message), {packageInfo: packageInfo, deviceList: [], moduleInstallPath: modulePath});
      unsafeDomain.run(function() { _this.loadModuleAndQueryDevice(modulePath, name, version, packageInfo, callback); });
    });
  } else {
    unsafeDomain.run(function() { _this.loadModuleAndQueryDevice(modulePath, name, version, packageInfo, callback); });
  }
};

ModuleManager.prototype.loadModuleAndQueryDevice = function(modulePath, name, version, packageInfo, callback) {
  this.loadModuleFromPath(modulePath, name, version, function(e, mi) {
    if (e != null) return callback(new CdifError('MODULE_INSTALL_FAIL', name, e.message, e.stack), {packageInfo: packageInfo, deviceList: [], moduleInstallPath: modulePath});
    moduleInstance = mi;

    //give time to allow device online
    setTimeout(function() {
      //get the list of device objects which belongs to moduleInstance
      //this event is handled by device manager
      this.emit('querydevicelist', moduleInstance, packageInfo, function(err, info) {
        if (info != null) { info.moduleInstallPath = modulePath }; //append module install path to return result
        return callback(err, info);
      });
    }.bind(this), 2000);
  }.bind(this));
};

ModuleManager.prototype.onQueryDeviceListResult = function(error, deviceList, packageInfo, callback) {
  if (packageInfo != null && packageInfo.name != null) {
    return callback(error, {packageInfo: packageInfo, deviceList: deviceList});  // in case of error, packageInfo is the original one we passed in to querydevice event, deviceList will be []
  } else {
    return callback(new CdifError('MODULE_PACKAGE_INFO_INVALID'));
  }
};

module.exports = ModuleManager;
