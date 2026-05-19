const { createPythonCarrier } = require('../lib/python_carrier');

const trackCMA = createPythonCarrier({
  carrier: 'CMA',
  scriptName: 'cma_uc.py',
  defaultTrackingNumber: 'SGN2968351',
});

module.exports = trackCMA;

if (require.main === module) {
  const trackingNumber = process.argv[2] || 'SGN2968351';
  trackCMA(trackingNumber).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'success' ? 0 : 1);
  });
}
