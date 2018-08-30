var argv          = require('minimist')(process.argv.slice(1));
var options       = require('./lib/cli-options');
var deviceDB      = require('@apemesh/cdif-device-db');
var mkdirp        = require('mkdirp');
var fs            = require('fs');
var packageJson   = require(__dirname + '/package.json');

process.on('uncaughtException', function(e) {
  console.error('Error: ' + e.stack);
});

process.on('warning', function(e) {
  console.warn(e.stack);
});

options.setOptions(argv);

var logger = require('./lib/logger');
logger.createLogger(options.logStream);
var monitor       = require('./lib/monitor');

logger.I('cdif@' + packageJson.version + ' start with options:' + JSON.stringify(options));

try {
  // create module folder
  mkdirp.sync(options.modulePath);
  fs.accessSync(options.modulePath, fs.W_OK);
} catch (e) {
  logger.E(new Error('cannot access module folder: ' + e.message));
  process.exit(-1);
}

deviceDB.init(options.modulePath);

var ModuleManager = require('./lib/module-manager');
var RouteManager  = require('./lib/route-manager');

var mm = new ModuleManager();

monitor.init(mm);

var routeManager = new RouteManager(mm);

routeManager.installRoutes();
mm.loadAllModules();


// forever to restart on crash?
