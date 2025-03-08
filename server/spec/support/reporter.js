const { JUnitXmlReporter } = require('jasmine-reporters');

const reporter = new JUnitXmlReporter({
  savePath: './test-results',
  consolidateAll: true
});

jasmine.getEnv().addReporter(reporter);

