// Pure request adapters; importing this package never imports valve-control.
module.exports = Object.assign({},
  require('./command-ingress'),
  require('./manual-ingress'),
  require('./cancel-ingress'),
  require('./service-interval-ingress'),
  require('./service-model-ingress'),
  require('./service-timed-ingress'),
  require('./service-magnet-ingress'),
  require('./service-partial-ingress'),
  require('./service-flush-ingress'),
  require('./run-log-adapters')
);
