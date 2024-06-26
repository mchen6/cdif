var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://127.0.0.1:9527';

describe('test18: invoke with BSON content-type with binary data', function() {
  this.timeout(0);
  var req = BSON.serialize({ serviceID: 'urn:apemesh-com:serviceID:echoService', actionName: 'echo', input: {foo: [{item1: '111', item2: false}], bar: '222', binaryData: Buffer.from('abcdefg')} });

  it('invoke with BSON content-type with binary data', function(done) {
    request(url).post('/devices/c5284c70-ae5f-591c-b2f1-cf0b4ebd0767/invoke-action')
    .set('X-Apemesh-Key', 'aabbcc')
    .set('Content-Type', 'application/bson')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(200, function(err, res) {
      if (err) return done(new Error('test18 fail: ' + err.message));

      if (res.body.output == null
        || res.body.output.binaryData == null
        || res.body.output.binaryData[0] !== 97
        || res.body.output.binaryData[1] !== 98
        || res.body.output.binaryData[2] !== 99
        || res.body.output.binaryData[3] !== 100
        || res.body.output.binaryData[4] !== 101
        || res.body.output.binaryData[5] !== 102
        || res.body.output.binaryData[6] !== 103
      ) {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(BSON.deserialize(req))));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test18 fail'));
      }

      return done();
    });
  });
});
