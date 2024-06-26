var events      = require('events');
var util        = require('util');
var url         = require('url');
var parser      = require('json-schema-ref-parser');
var UUID        = require('uuid-1345');

var Service     = require('./service');
var ConnMan     = require('./connect');
var validator   = require('./validator');
var LOG         = require('./logger');
var options     = require('./cli-options');
var Session     = require('./session');
var CdifError   = require('./cdif-error').CdifError;
var DeviceError = require('./cdif-error').DeviceError;

var OAuth2Server  = require('oauth2-server');
var OAuthRequest  = OAuth2Server.Request;
var OAuthResponse = OAuth2Server.Response;

//warn: try not add event listeners in this class
function CdifDevice(spec) {
  this.deviceID        = '';
  this.user            = '';
  this.secret          = '';
  this.rateLimiter     = null;
  this.connectionState = 'disconnected';  // enum of disconnected, connected, & redirecting
  this.connMan     = new ConnMan(this);
  this.schemaDoc   = this.getDeviceRootSchema();

  this.spec = spec;
  this.initServices();


  this.deviceID = UUID.v5({
    namespace: UUID.namespace.url,
    name: 'https://registry.apemesh.com/packages/' + spec.device.friendlyName
  });
  // annotate generated deviceID to spec object
  this.spec.device.deviceID = this.deviceID;

  this.getDeviceSpec          = this.getDeviceSpec.bind(this);
  this.connect                = this.connect.bind(this);
  this.disconnect             = this.disconnect.bind(this);
  this.getHWAddress           = this.getHWAddress.bind(this);
  this.deviceControl          = this.deviceControl.bind(this);
  this.subscribeDeviceEvent   = this.subscribeDeviceEvent.bind(this);
  this.unsubscribeDeviceEvent = this.unsubscribeDeviceEvent.bind(this);
}

util.inherits(CdifDevice, events.EventEmitter);


CdifDevice.prototype.setAction = function(serviceID, actionName, action) {
  if (action === null || typeof(action) !== 'function') {
    return LOG.DE(this, new DeviceError('SET_INCORRECT_ACTION_TYPE', serviceID, actionName));
  }

  var service = this.services[serviceID];
  if (service != null && service.actions != null && service.actions[actionName] != null) {
    return service.actions[actionName].invoke = action.bind(this);
  }

  if (service == null)                     return LOG.DE(this, new DeviceError('CANNOT_SET_ACTION_SERVICE_OBJ_NOT_EXIST', serviceID, actionName));
  if (service.actions == null)             return LOG.DE(this, new DeviceError('CANNOT_SET_ACTION_ACTION_LIST_NOT_EXIST', serviceID, actionName));
  if (service.actions[actionName] == null) return LOG.DE(this, new DeviceError('CANNOT_SET_ACTION_OBJ_NOT_EXIST', serviceID, actionName));

  return LOG.DE(this, new DeviceError('CANNOT_SET_ACTION', serviceID, actionName));
};

CdifDevice.prototype.initServices = function() {
  if (typeof(this.spec) !== 'object' || this.spec.device == null || this.spec.device.serviceList == null) {
    return LOG.DE(this, new DeviceError('NO_VALID_DEVICE_SPEC', this.constructor.name));
  }

  var serviceList = this.spec.device.serviceList;

  if (!this.services) {
    this.services = new Object();
  }
  for (var i in serviceList) {
    var service_spec = serviceList[i];
    if (!this.services[i]) {
      this.services[i] = new Service(this, i, service_spec);
    } else {
      this.services[i].updateSpec(service_spec);
    }
  }
};

CdifDevice.prototype.getDeviceSpec = function(session) {
  var cb = null;

  if (typeof(session) === 'function') {
    cb = session;
  } else {
    cb = session.callback;
  }

  if (this.spec === null) {
    return cb(new CdifError('CANNOT_GET_DEVICE_SPEC'), null);
  }
  return cb(null, this.spec);
};

// this api may be called by device module or interface, so session could be a real Session obj or a normal callback
CdifDevice.prototype.getServiceStates = function(serviceID, session) {
  if (session == null) {
    return LOG.DE(this, new DeviceError('GET_SERVICE_STATE_FAIL_INVALID_CALLBACK'));
  }
  var callback = null;
  if (session instanceof Session) {
    callback = session.callback;
  } else if (typeof(session) === 'function') {
    callback = session;
  } else {
    return LOG.DE(this, new DeviceError('GET_SERVICE_STATE_FAIL_INVALID_CALLBACK'));
  }

  var service = this.services[serviceID];
  if (service == null) {
    return callback(new DeviceError('SERVICE_NOT_FOUND', serviceID), null);
  }
  service.getServiceStates(callback);
};

CdifDevice.prototype.setServiceStates = function(serviceID, values, callback) {
  if (callback == null || typeof(callback) !== 'function') {
    return LOG.DE(this, new CdifError('GET_SERVICE_STATE_FAIL_INVALID_CALLBACK'));
  }
  var service = this.services[serviceID];
  if (service == null) {
    var error = new DeviceError('SERVICE_NOT_FOUND', serviceID);
    LOG.DE(this, error);
    return callback(error);
  }

  service.setServiceStates(values, callback);
};

// now support only one user / pass pair
// TODO: check if no other case than oauth redirect flow needs to temporarily unset connected flag
CdifDevice.prototype.connect = function(user, pass, callback) {
  if (this.connectionState === 'redirecting') {
    return callback(new CdifError('DEVICE_IN_ACTION'), null, null);
  }

  if (this.connectionState === 'connected') {
    return this.connMan.verifyConnect(user, pass, callback);
  }
  return this.connMan.processConnect(user, pass, callback);
};

CdifDevice.prototype.disconnect = function(session) {
  return this.connMan.processDisconnect(session.callback);
};

CdifDevice.prototype.getHWAddress = function(callback) {
  if (this._getHWAddress && typeof(this._getHWAddress) === 'function') {
    this._getHWAddress(function(error, data) {
      if (error) {
        var err = new DeviceError('GET_HARDWARE_ADDR_FAIL', error.message);
        LOG.DE(this, err);
        return callback(err, null);
      }
      callback(null, data);
    }.bind(this));
  } else {
    callback(null, null);
  }
};

CdifDevice.prototype.deviceControl = function(serviceID, actionName, args, session) {
  var service = this.services[serviceID];
  if (service == null) {
    if (typeof(session) === 'function') {
      return session(new DeviceError('SERVICE_NOT_FOUND', serviceID), null);
    }
    return session.callback(new DeviceError('SERVICE_NOT_FOUND', serviceID), null);
  }
  return service.invokeAction(actionName, args, session);
};

CdifDevice.prototype.invokeDeviceCallback = function(path, data, session) {
  var cb = null;

  if (typeof(session) === 'function') {
    cb = session;
  } else {
    cb = session.callback;
  }

  if (this._deviceCallbackHandler == null || typeof(this._deviceCallbackHandler) !== 'function') {
    return cb(new DeviceError('DEVICE_CALLBACK_NOT_AVAILABLE'), null);
  }
  this._deviceCallbackHandler(path, data, function(err, output) {
    if (err != null) {
      var error = null;
      if (err instanceof DeviceError || err instanceof CdifError) {
        error = err;
      } else {
        error = new DeviceError('DEVICE_INVOKE_CALLBACK_FAIL', err.message);
      }
      return cb(error, output);
    }
    return cb(null, output);
  });
};

CdifDevice.prototype.updateDeviceSpec = function(newSpec) {
  validator.validateDeviceSpec(newSpec, function(error) {
    if (error) {
      return LOG.DE(this, new DeviceError('DEVICE_SPEC_UPDATE_FAIL', error.message, JSON.stringify(newSpec)));
    }
    this.spec = newSpec;
    this.initServices();
  }.bind(this));
};

CdifDevice.prototype.setEventSubscription = function(serviceID, subscribe, unsubscribe) {
  if (typeof(subscribe) !== 'function' || typeof(unsubscribe) !== 'function') {
    return LOG.DE(this, new DeviceError('EVENT_SUBSCRIBER_TYPE_ERROR'));
  }
  var service = this.services[serviceID];
  if (service) {
    service.setEventSubscription(subscribe.bind(this), unsubscribe.bind(this));
  } else {
    LOG.DE(this, new DeviceError('SERVICE_NOT_FOUND', serviceID));
  }
};

CdifDevice.prototype.subscribeDeviceEvent = function(serviceID, actionName, input, inputKey, callback) {
  var service = this.services[serviceID];
  if (service == null) {
    return callback(new DeviceError('SERVICE_NOT_FOUND', serviceID));
  }

  service.subscribeEvent(actionName, input, inputKey, callback);
  // , function(err) {
  //   if (!err) {
  //     service.addListener('serviceevent', subscriber.publish);
  //   }
  //   session.callback(err);
  // });
};

CdifDevice.prototype.unsubscribeDeviceEvent = function(serviceID, actionName, input, inputKey, callback) {
  var service = this.services[serviceID];
  if (service == null) {
    return callback(new DeviceError('SERVICE_NOT_FOUND', serviceID));
  }

  service.unsubscribeEvent(actionName, input, inputKey, callback);
  // service.removeListener('serviceevent', subscriber.publish);
  // if (service.listeners('serviceevent').length === 0) {
  //   service.unsubscribeEvent(session.callback);
  // } else {
  //   session.callback(null);
  // }
};

// get device root url string
CdifDevice.prototype.getDeviceRootUrl = function(session) {
  if (this.spec.device.devicePresentation !== true || typeof(this._getDeviceRootUrl) !== 'function') {
    return session.callback(new DeviceError('PRESENTATION_NOT_SUPPORTED'), null);
  }
  this._getDeviceRootUrl(function(err, data) {
    if (err) {
      return session.callback(new DeviceError('GET_DEVICE_ROOTURL_FAIL', err.message), null);
    }
    try {
      url.parse(data);
    } catch(e) {
      return session.callback(new DeviceError('PARSE_DEVICE_ROOTURL_FAIL', e.message), null);
    }
    session.callback(null, data);
  });
};

// get device root schema document object, must be sync
CdifDevice.prototype.getDeviceRootSchema = function() {
  if (typeof(this._getDeviceRootSchema) !== 'function') return null;
  try {
    return this._getDeviceRootSchema();
  } catch (e) {
    LOG.DE(this, new DeviceError('GET_DEVICE_SCHEMADOC_FAIL', e.message));
    return null;
  }
};

CdifDevice.prototype.destroyCdifDevice = function() {
  if (typeof(this._destroyDevice) !== 'function') return null;
  try {
    return this._destroyDevice();
  } catch (e) {
    LOG.DE(this, new DeviceError('DESTROY_DEVICE_FAIL', e.message));
    return null;
  }
};

// resolve JSON pointer based schema ref and return the schema object associated with it
// For now we only support single doc schema to avoid security risks when resolving external refs
CdifDevice.prototype.resolveSchemaFromPath = function(path, self, callback) {
  var schemaDoc = this.schemaDoc;
  if (schemaDoc == null || typeof(schemaDoc) !== 'object') {
    return callback(new DeviceError('INVALID_DEVICE_SCHEMADOC'), self, null);
  }
  if (path === '/') {
    return callback(null, self, schemaDoc);
  }

  var doc = null;
  try {
    doc = JSON.parse(JSON.stringify(schemaDoc));
  } catch(e) {
    return callback(new DeviceError('INVALID_DEVICE_SCHEMADOC', e.message), self, null);
  }

  var ref;

  // for now we dont support fragment based pointer
  // because it won't be able to be resolved
  if (/^\/./.test(path) === false) {
    return callback(new CdifError('INVALID_JSON_POINTER'), self, null);
  }

  ref = '#' + path;

  doc.__ =  {
    "$ref": ref
  };

  parser.dereference(doc, {$refs: {external: false}}, function(err, out) {
    if (err) {
      return callback(new CdifError('POINTER_DEREF_ERROR', err.message), self, null);
    }
    callback(null, self, out.__);
  });
};

CdifDevice.prototype.setOAuthAccessToken = function(params, session) {
  if (typeof(this._setOAuthAccessToken) === 'function') {
    this._setOAuthAccessToken(params, function(err) {
      if (err) {
        return session.callback(new CdifError(err.message));
      }
      this.connectionState = 'connected';
      session.callback(null);
    }.bind(this));
  } else {
    session.callback(new CdifError('CANNOT_SET_OAUTH_ACCESS_TOKEN_INVALID_INTERFACE'));
  }
};



//callback null indicate validation success and otherwise fail
CdifDevice.prototype.oauthTokenValidate = function(session, callback) {
  if (options.debug === true) return callback();           // under debug mode we don't do oauth token validation
  if (typeof(session) === 'function') return callback();   // we are in worker thread, there is no session obj

  //20191107: we decide to move oauth validation code down to devices
  // so we can support per-device oauth validation
  // because we can't pass express's app obj to worker thread, this token validation should
  // always happens in main thread
  if (this.spec.device && this.spec.device.requireOAuthAccessToken === true) {
    var req = session.req;
    var res = session.res;

    if (req == null || res == null) return callback();

    var request  = new OAuthRequest(req);
    var response = new OAuthResponse(res);
    var app      = req.app;

    if (app == null) return callback();
    return app.oauth.authenticate(request, response, {}, callback);
  }

  return callback();
};

module.exports = CdifDevice;
