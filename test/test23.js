var request = require('supertest');
var jsf     = require('json-schema-faker');
var chalk   = require('chalk');
var BSON    = require('bson');

jsf.option({
  alwaysFakeOptionals: true
});

var url = 'http://192.168.0.15:9527';

describe('test23: invoke return string type as output', function() {
  this.timeout(0);
  var req = { serviceID: 'urn:apemesh-com:serviceID:errorInfoTestService', actionName: 'testStringTypeReturnError', input: {} };

  it('invoke return string type as output', function(done) {
    request(url).post('/devices/b752c14b-27ec-5374-a2ca-0ce71c247566/invoke-action')
    .send(req)
    .expect('Content-Type', /[json | text]/)
    .expect(500, function(err, res) {
      if (err) return done(err);

      if (res.body.message.startsWith('输出数据校验错误') === false || res.body.fault.reason !== '未找到输出参数') {
        console.error(chalk.white.bgRed.bold('Request:' + JSON.stringify(req)));
        console.error(chalk.white.bgRed.bold('Response: ' + JSON.stringify(res.body)));
        return done(new Error('test23 fail'));
      }
      return done();
    });
  });
});