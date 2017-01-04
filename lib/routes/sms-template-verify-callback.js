var LOG          = require('../logger');
var options      = require('../cli-options');
var querystring  = require('querystring');
var nano         = require('nano')(options.dbUrl);
var CdifError    = require('../error').CdifError;
var url          = require('url');
var request      = require('request');

var usersDB  = nano.db.use('_users');
var tmplDB   = nano.db.use('sms_template');

var tmplCallbackDeviceID = 'f5dc73f9-b739-5ee2-add7-e499da04c6ec';

var templateVerifyCallback = function(req, res, next) {
  var deviceID = req.params.deviceID;

  if (deviceID !== tmplCallbackDeviceID) return next();

  if (req.body) {
    // identify this is a callback request, not an api call
    if (req.body.templateId == null || req.body.status == null) return next();

    var templateID = req.body.templateId.toString();
    var status     = req.body.status.toString();

    tmplDB.view('smsTemplate', 'byTemplateID', {key: templateID}, function(err, doc) {
      if (doc.rows.length === 0) {
        LOG.E(new CdifError('DB didnt find this templateID: ' + templateID + ' , status: ' + status));
        return res.sendStatus(200);
      } else if (doc.rows.length > 1) {
        LOG.E(new CdifError('dont know how to update non unique templateID: ' + templateID + ' , status: ' + status));
        return res.sendStatus(200);
      }

      var docID = doc.rows[0].id;
      tmplDB.get(docID, function(err, body) {
        if (err) {
          LOG.E(new CdifError('get tmplDB document failed: ' + err.message + ' , templateID: ' + templateID + ' , status: ' + status));
          return res.sendStatus(200);
        }

        // the record in db -- 1: approving, 2: rejected 3: approved
        if (status === '1') {
          body.status = 3;
        } else {
          body.status = 2;
          status = 0;
        }
        tmplDB.insert(body, function(error, result) {
          if (error) {
            LOG.E(new CdifError('update tmplDB document failed: ' + error.message + ' , templateID: ' + templateID + ' , status: ' + status));
            return res.sendStatus(200);
          }
          // lookup users DB to see if callback URL is specified, if yes then call it
          usersDB.view('user', 'byTemplateAuditPushUrl', {key: body.name}, function(err, doc) {
            if (err) {
              LOG.E(new CdifError('get template callback url failed: ' + err.message + ' , templateID: ' + templateID + ' , user: ' + body.name));
              return res.sendStatus(200);
            }

            if (doc.rows.length === 0) {
              return res.sendStatus(200);
            }
            if (typeof(doc.rows[0].value) !== 'string') {
              LOG.I('template audit callback malform: ' + doc.rows[0].value);
              return res.sendStatus(200);
            }
            if (doc.rows[0].value === '') {
              return res.sendStatus(200);
            }
            //url sanity check
            try {
              var urlObj = url.parse(doc.rows[0].value);
            } catch (e) {
              LOG.I('template audit callback parse failed: ' + doc.rows[0].value);
              return res.sendStatus(200);
            }
            var callbackURL = doc.rows[0].value + '?' + querystring.stringify({templateID: body._id, status: status});
            LOG.I('template audit callback: ' + callbackURL);
            request(callbackURL, function(err) {
              if (err) {
                LOG.I('template audit callback failed: ' + err.message + ', URL: ' + callbackURL);
              }
            });
            return res.sendStatus(200);
          });
        });
      });
    });
  } else {
    return res.sendStatus(200);
  }
}

module.exports = templateVerifyCallback;