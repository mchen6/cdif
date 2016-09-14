var ModuleManager = require('./lib/module-manager');
var RouteManager  = require('./lib/route-manager');
var argv          = require('minimist')(process.argv.slice(1));
var options       = require('./lib/cli-options');
var logger        = require('./lib/logger');
var deviceDB      = require('./lib/device-db');

options.setOptions(argv);
logger.createLogger();
deviceDB.init();

var mm = new ModuleManager();
var routeManager = new RouteManager(mm);


routeManager.installRoutes();
mm.loadAllModules();


// forever to restart on crash?
