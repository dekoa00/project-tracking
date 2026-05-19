const { createPythonCarrier } = require('../lib/python_carrier');

const trackRCL = createPythonCarrier({
  carrier: 'RCL',
  scriptName: 'rcl_uc.py',
  defaultTrackingNumber: 'SGNCB25051355',
});

module.exports = trackRCL;

if (require.main === module) {
  const trackingNumber = process.argv[2] || 'SGNCB25051355';
  trackRCL(trackingNumber).then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'success' ? 0 : 1);
  });
}
