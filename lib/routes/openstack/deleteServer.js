var express   = require('express');
var Session   = require('../../session');

module.exports = function(mm, cdifInterface) {
  var router = express.Router({mergeParams: true});

  router.route('/').post(function(req, res) {
    var session = new Session(req, res, 'unknown', 'oc_delete_server', 0, null, null, null);

    var token      = req.get('X-Auth-Token');
    var tenantID   = req.params.tenantID;
    var serverID   = req.params.serverID;

    //map to our fixed deviceID, serviceID and actionName and send api request data to this driver module
    var deviceID   = '46932cf8-07f0-501b-9491-120ae4efd2c2';
    var serviceID  = 'urn:10086-cn:serviceID:弹性计算服务';
    var actionName = '云主机删除';

    // build argument object and uniformly use 'input' to identify input argument
    var argumentList = {};
//    argumentList.token = token;
    argumentList.input = {};
    argumentList.input.token = token;
    cdifInterface.invokeDeviceAction(deviceID, serviceID, actionName, argumentList, token, session);
  });
  return router;
}
