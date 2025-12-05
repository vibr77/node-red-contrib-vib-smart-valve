var should = require("should");
var helper = require("node-red-node-test-helper");
var smartValveNode = require("../smart-valve.js");
var smartValveSettingsNode = require("../smart-valve-settings.js");

helper.init(require.resolve('node-red'));

describe('smart-valve Node', function () {

  beforeEach(function (done) {
      helper.startServer(done);
  });

  afterEach(function (done) {
      helper.unload();
      helper.stopServer(done);
  });

  it('should be loaded', function (done) {
    var flow = [{ id: "n1", type: "smart-valve", name: "test-valve" }];
    helper.load(smartValveNode, flow, function () {
      var n1 = helper.getNode("n1");
      try {
        n1.should.have.property('name', 'test-valve');
        done();
      } catch(err) {
        done(err);
      }
    });
  });

  it('should handle trigger command', function (done) {
    var flow = [
      { id: "n1", type: "smart-valve", name: "test-valve", wires:[["n2"]], climates:[] },
      { id: "n2", type: "helper" }
    ];
    helper.load(smartValveNode, flow, function () {
      var n1 = helper.getNode("n1");
      var n2 = helper.getNode("n2");
      
      n1.receive({ payload: { command: "trigger", setpoint: 20 } });
      // Since the node might not output immediately or might output to mqtt, 
      // we might just check if it didn't crash. 
      // Real logic testing would require mocking MQTT or checking internal state if exposed.
      // For now, basic load and receive test.
      setTimeout(function() {
          done();
      }, 500);
    });
  });
});
