var events        = require('events');
var util          = require('util');
var http          = require('http');
var express       = require('express');
var url           = require('url');
var cors          = require('cors');
var bodyParser    = require('body-parser');
var morgan        = require('morgan');
var OAuth2Server  = require('oauth2-server');
var CdifUtil      = require('./cdif-util');
var SocketServer  = require('./socket-server');
// var WSServer      = require('./ws-server');
var CdifInterface = require('./cdif-interface');
var Session       = require('./session');
var CdifError     = require('./cdif-error').CdifError;
var options       = require('./cli-options');
var LOG           = require('./logger');

var OAuthRequest  = OAuth2Server.Request;
var OAuthResponse = OAuth2Server.Response;

var AccessDeniedError = require('oauth2-server/lib/errors/access-denied-error');

var proxyHandler  = require('./proxy-handler');

require('body-parser-xml')(bodyParser);

var oauthCallbackUrl   = '/callback_url';

function RouteManager(mm) {
  this.app = express();

  this.moduleManager = mm;
  this.cdifInterface = new CdifInterface(mm);

  this.deviceControlRouter = express.Router();
  this.callbacksRouter     = express.Router();
  this.presentationRouter  = express.Router({mergeParams: true});

  this.server = http.createServer(this.app);

  this.app.use(function (req, res, next) {
    delete req.headers['content-encoding'];
    next();
  });

  this.app.use(cors());

  if (options.reverseProxy === true) {
    // must put this before body parser because it will consume incoming requests
    this.installReverseHttpProxyRoutes(this.app, function(err) {
      if (err) LOG.I('reverse proxy error: ' + err.message);

      this.installNormalRoutes();
      this.startServer();
    }.bind(this));
  } else {
    this.installNormalRoutes();
    this.startServer();
  }
}

util.inherits(RouteManager, events.EventEmitter);

RouteManager.prototype.installNormalRoutes = function() {
  this.app.use(bodyParser.raw({type: ['application/bson'], limit: '1gb'})); //parse bson media type as raw buffer
  this.app.use(bodyParser.json({type: ['application/json', 'text/plain'], limit: '1gb'}));
  this.app.use(bodyParser.xml({limit: '1gb'}));
  this.app.use(bodyParser.urlencoded({extended:true, type: ['application/x-www-form-urlencoded'], limit: '1gb'}));

  // this.createOAuthServer(this.app);

  // global routes base path
  this.app.use('/devices',   this.deviceControlRouter);
  this.app.use('/callbacks', this.callbacksRouter);

  if (options.verifyModule === true || options.debug === true) {
    this.app.use('/verify-module', require('./routes/verify-module')(this.moduleManager, this.cdifInterface));
    this.app.use('/get-module-device-list', require('./routes/get-module-device-list')(this.moduleManager, this.cdifInterface));
    //TODO: move this route outside and be protected by user validation route if normal user requires module reload functionality
    this.app.use('/reload-module', require('./routes/reload-module')(this.moduleManager, this.cdifInterface));
    this.app.use('/shutdown',      require('./routes/shutdown')());
  }

  if (options.debug === true) {
    this.app.use('/load-module',    require('./routes/load-module')(this.moduleManager, this.cdifInterface));
    this.app.use('/unload-module',  require('./routes/unload-module')(this.moduleManager, this.cdifInterface));
    this.app.use('/restart-module', require('./routes/restart-module')(this.moduleManager, this.cdifInterface));
  }


  if (options.loadProfile === true) {
    this.app.use('/load-profile',  require('./routes/load-profile')(this.moduleManager, this.cdifInterface));
  }

  // if (options.wetty === true) {
  //   require('../wetty/app.js')(this.server, this.app);
  // }

  //TODO: move this to callback routes
  this.app.use('/callback_url', require('./routes/oauth-callback')(this.moduleManager, this.cdifInterface));
  this.app.use('/device-list',  require('./routes/device-list')(this.moduleManager, this.cdifInterface));

  //callback don't do user auth
  this.callbacksRouter.use('/:deviceID', require('./routes/callbacks')(this.moduleManager, this.cdifInterface));

  if (options.simOpenStackAPI === true) {
    // openstack api simulation don't do user auth
    this.installOpenStackRoutes(this.app, this.moduleManager, this.cdifInterface);
  }

  //ws routes also don't do http header based user auth
  if (options.wsServer === true) {
    LOG.I('enable websocket server');
    var expressWs = require('express-ws')(this.app, this.server);
    this.deviceControlRouter.use('/:deviceID/wss', require('./routes/wss').getRouter(this.moduleManager, this.cdifInterface));
    // this.wsServer = new WSServer(this.server, this.cdifInterface);
    //TODO: add verifyClient support here
    // wsOptions: { //<-- express-ws allows passing options nested as this property.
    //   verifyClient: function (info, cb) {
    //     const user = require('basic-auth')(info.req);
    //     if ( ! user || ! auth.authorized(user.name, user.pass)) {
    //       return cb(false, 401, "Unauthorized");
    //     } else return cb(true);
    //   }
    // }
  } else if (options.sioServer === true) {
    LOG.I('enable socketIO server');
    this.socketServer = new SocketServer(this.server, this.cdifInterface);
    this.socketServer.installHandlers();
  }
  //per device routes
  //user validation
  this.deviceControlRouter.use('/:deviceID',                  require('./routes/user'));
  this.deviceControlRouter.use('/:deviceID/connect',          require('./routes/connect')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/disconnect',       require('./routes/disconnect')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/invoke-action',    require('./routes/invoke-action')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-spec',         require('./routes/get-spec')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/get-state',        require('./routes/get-state')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/event-sub',        require('./routes/event-sub')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/event-unsub',      require('./routes/event-unsub')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/schema',           require('./routes/schema')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/package-info',     require('./routes/get-device-package-info')(this.moduleManager, this.cdifInterface));
  this.deviceControlRouter.use('/:deviceID/download-package', require('./routes/download-device-package')(this.moduleManager, this.cdifInterface));

  this.deviceControlRouter.use('/:deviceID/add-job',        require('./routes/add-job')());
  this.deviceControlRouter.use('/:deviceID/get-job',        require('./routes/get-job')());
  this.deviceControlRouter.use('/:deviceID/get-job-history',require('./routes/get-job-history')());
  this.deviceControlRouter.use('/:deviceID/remove-job',     require('./routes/remove-job')());

  if (options.allowDiscover) {
    this.app.use('/',              require('./routes/user'));
    this.app.use('/discover',      require('./routes/discover')(this.moduleManager, this.cdifInterface));
    this.app.use('/stop-discover', require('./routes/stop-discover')(this.moduleManager, this.cdifInterface));
  }

  this.cdifInterface.on('presentation', this.mountDevicePresentationPage.bind(this));
};

RouteManager.prototype.mountDevicePresentationPage = function(deviceID) {
  this.deviceControlRouter.use('/:deviceID/presentation', this.presentationRouter);

  var session = new Session(null, null, null);
  session.callback = function(err, deviceUrl) {
    if (!err) {
      this.presentationRouter.use('/', function(req, res) {
        var redirectedUrl = deviceUrl + req.url;
        res.redirect(redirectedUrl);
      });
    } else {
      LOG.E(new CdifError('GET_DEVICE_ROOTURL_FAIL', err.message));
    }
  }.bind(this);

  this.cdifInterface.getDeviceRootUrl(deviceID, session);
};

RouteManager.prototype.startServer = function() {
  // setInterval(function() {
  //   this.server.getConnections(function(err, count) {
  //     console.log(count);
  //   });
  // }.bind(this), 100);

  this.server.listen(options.port, CdifUtil.getHostIp());
  LOG.I('cdif listen on: ' + CdifUtil.getHostIp() + ':' + options.port);
};

RouteManager.prototype.installOpenStackRoutes = function(app, mm, ci) {
  app.use('/v2/:tenantID/servers', require('./routes/openstack/createServer')(mm, ci));
  app.use('/v2/:tenantID/servers/:serverID', require('./routes/openstack/deleteServer')(mm, ci));
};

RouteManager.prototype.installReverseHttpProxyRoutes = function(app, callback) {
  app.use('/api-proxy/:deviceID', require('./routes/user'));

  proxyHandler.loadAllProxyHosts(function(err) {
    if (err) return callback(err);
    proxyHandler.installProxyRoutes(app);
    return callback(null);
  });
};

RouteManager.prototype.createOAuthServer = function(app) {
  app.oauth = new OAuth2Server({
          model: require('./oauth/oauth-server-model.js'),
          grants: ['authorization_code', 'refresh_token', 'password'],
          accessTokenLifetime: 60 * 60 * 24,
          allowBearerTokensInQueryString: true,
          allowExtendedTokenAttributes: true,
          allowEmptyState: true
  });

  app.post('/oauth-token', function(req, res) {
    var request = new OAuthRequest(req);
    var response = new OAuthResponse(res);

    return app.oauth.token(request, response)
      .then(function(token) {
        console.log(token);
        res.json(token);
      }).catch(function(err) {
        res.status(err.code || 500).json({error: err.message});
      });
  });

  app.post('/oauth-authorize', function(req, res) {
    var username = req.body.username;
    var password = req.body.password;
    req.body.user = {user: 1};

    var request = new OAuthRequest(req);
    var response = new OAuthResponse(res);


    return app.oauth.authorize(request, response, {
        authenticateHandler: {
          handle: function(request, response) {
            //TODO: validate username
            //which needs to engage with customized code which should be put to oauth-server-model
            // I think actually we don't need to verify password here
            // because we only need to verify user's identity in the userDB, to be able to generate JWT which contains user information
            return {};
          }
        }
      }
    ).then(function(success) {
        console.log(success);
        res.json(success)
    }).catch(function(err) {
      res.status(err.code || 500).json({error: err.message})
    });
  });

  //20191107: we decide to move oauth validation code down to devices
  // so we can support per-device oauth validation
};

module.exports = RouteManager;
