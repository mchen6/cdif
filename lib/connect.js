var CdifError   = require('./cdif-error').CdifError;
var DeviceError = require('./cdif-error').DeviceError;

function ConnectManager(cdifDevice) {
  this.device = cdifDevice;
}

//TODO: support multi-user secrets
ConnectManager.prototype.verifyConnect = function(user, pass, callback) {
  callback(null, null, null);
  // if (this.device.spec.device.userAuth === true && !this.device.isOAuthDevice) {
  //   if (this.device.secret === '') {
  //     return callback(new CdifError('cannot verify password'), null, null);
  //   }
  //   if (this.device.user !== user) {
  //     return callback(new CdifError('username not match'), null, null);
  //   }
  //   this.device.auth.compareSecret(pass, this.device.secret, function(err, res) {
  //     if (!err && res === true) {
  //       return callback(null, this.device.secret, null);
  //     }
  //     if (!err) {
  //       return callback(new CdifError('password not match'), null, null);
  //     }
  //     return callback(new CdifError(err.message), null, null);
  //   }.bind(this));
  // } else {
  //   callback(null, null, null);
  // }
};

//TODO: connect args may contain return and cancel URL from client which we can redirect to after OAuth flow is done
ConnectManager.prototype.processConnect = function(user, pass, callback) {
  if (this.device._connect && typeof(this.device._connect) === 'function') {
    this.device._connect(user, pass, function(error, redirectObj) {
      if (error) {
        return callback(new DeviceError('DEVICE_CONNECT_FAIL', error.message), null, null);
      }

      if (redirectObj != null) {
        if (typeof(redirectObj) !== 'object') {
          return callback(new DeviceError('INVALID_REDIRECT_URL'), null, null);
        }
        if (redirectObj.href == null || redirectObj.method == null) {
          return callback(new DeviceError('INVALID_REDIRECT_URL', JSON.stringify(redirectObj)), null, null);
        }
        this.device.connectionState = 'redirecting';
      } else {
        this.device.connectionState = 'connected';
      }
      callback(null, null, redirectObj);
      // if (this.device.spec.device.userAuth === true && !this.device.isOAuthDevice) {
      //   this.device.auth.getSecret(this.device.deviceID, pass, function(err, secret) {
      //     if (!err) {
      //       this.device.user = user;
      //       this.device.secret = secret;
      //     }
      //     callback(err, secret);
      //   }.bind(this));
      // } else {
      //   callback(null, null, redirectObj);
      // }
    }.bind(this));
  } else {
    this.device.connectionState = 'connected';
    callback(null, null, null);
  }
  //   if (this.device.spec.device.userAuth === true) {
  //     // TODO: may create auth strategy later on
  //     callback(new CdifError('cannot authenticate this device'), null, null);
  //   } else {
  //     this.device.connectionState = 'connected';
  //     callback(null, null, null);
  //   }
  // }
};

ConnectManager.prototype.processDisconnect = function(callback) {
  if (this.device.connectionState === 'connected' || this.device.connectionState === 'redirecting') {
    if (this.device._disconnect && typeof(this.device._disconnect) === 'function') {
      this.device._disconnect(function(error) {
        if (error) {
          return callback(new DeviceError('DEVICE_DISCONNECT_FAIL', error.message));
        }
        // if (this.device.spec.device.userAuth === true && !this.device.isOAuthDevice) {
        //   this.device.user = ''; this.device.secret = '';
        // }
        this.device.connectionState = 'disconnected';
        callback(null);
      }.bind(this));
    } else {
      // if (this.device.spec.device.userAuth === true) {
      //   this.device.user = ''; this.device.secret = '';
      // }
      this.device.connectionState = 'disconnected';
      callback(null);
    }
  } else {
    callback(new DeviceError('DEVICE_NOT_CONNECTED'));
  }
};

module.exports = ConnectManager;
