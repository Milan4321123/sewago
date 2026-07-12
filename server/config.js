require('dotenv').config({ quiet: true });

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const config = {
  nodeEnv,
  isProduction,
  port: Number(process.env.PORT) || 4000,
  trustProxy: !!process.env.TRUST_PROXY,
  dataStore: process.env.DATA_STORE || 'json',
  // Khalti ePayment (KPG-2). The method goes live when the secret key is set.
  khaltiSecretKey: process.env.KHALTI_SECRET_KEY || '',
  khaltiMode: process.env.KHALTI_MODE === 'live' ? 'live' : 'test',
  // eSewa ePay v2. The method goes live when product code + secret are set.
  esewaProductCode: process.env.ESEWA_PRODUCT_CODE || '',
  esewaSecret: process.env.ESEWA_SECRET || '',
  esewaMode: process.env.ESEWA_MODE === 'live' ? 'live' : 'test',
  // Where GPS pins and address search are accepted. 'kathmandu' locks rides
  // and deliveries to the valley (the launch market); 'global' accepts any
  // coordinates on earth so the full flow can be tested from anywhere.
  // Development defaults to global; production stays Kathmandu-only unless
  // SERVICE_AREA=global is set explicitly (e.g. for a remote pilot/test).
  serviceArea: ['kathmandu', 'global'].includes(process.env.SERVICE_AREA)
    ? process.env.SERVICE_AREA
    : (isProduction ? 'kathmandu' : 'global'),
  otpProvider: process.env.OTP_PROVIDER || 'sandbox',
  emailProvider: process.env.EMAIL_PROVIDER || 'sandbox',
  publicAppUrl: process.env.PUBLIC_APP_URL || '',
  androidApkUrl: process.env.ANDROID_APK_URL || '',
  iosAppStoreUrl: process.env.IOS_APP_STORE_URL || '',
  allowJsonDbInProduction: process.env.ALLOW_JSON_DB_IN_PRODUCTION === 'true',
  allowSandboxProvidersInProduction: process.env.ALLOW_SANDBOX_PROVIDERS_IN_PRODUCTION === 'true',
  allowDemoVerificationInProduction: process.env.ALLOW_DEMO_VERIFICATION_IN_PRODUCTION === 'true'
};

function validateProductionConfig() {
  if (!isProduction) return;

  const problems = [];
  if (!process.env.ADMIN_EMAIL) {
    problems.push('ADMIN_EMAIL must be set.');
  }
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'admin123') {
    problems.push('ADMIN_PASSWORD must be set to a non-default secret.');
  }
  if ((!process.env.DRIVER_LICENSE_DEMO_CODE || process.env.DRIVER_LICENSE_DEMO_CODE === '123456') &&
      !config.allowDemoVerificationInProduction) {
    problems.push('DRIVER_LICENSE_DEMO_CODE must be replaced with a real verification flow or a non-default code.');
  }
  if (config.dataStore === 'supabase' || config.dataStore === 'supabase_rows') {
    if (!process.env.SUPABASE_URL) problems.push(`SUPABASE_URL must be set when DATA_STORE=${config.dataStore}.`);
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY && !process.env.SUPABASE_SERVICE_KEY) {
      problems.push(`SUPABASE_SERVICE_ROLE_KEY must be set when DATA_STORE=${config.dataStore}.`);
    }
  }
  if (config.dataStore === 'json' && !config.allowJsonDbInProduction) {
    problems.push('DATA_STORE=json is local-demo storage. Use Postgres/Supabase, or set ALLOW_JSON_DB_IN_PRODUCTION=true only for a private pilot.');
  }
  const hasRealGateway = Boolean(config.khaltiSecretKey || (config.esewaProductCode && config.esewaSecret));
  if (!hasRealGateway && !config.allowSandboxProvidersInProduction) {
    problems.push('No real payment gateway configured. Set KHALTI_SECRET_KEY and/or ESEWA_PRODUCT_CODE + ESEWA_SECRET before taking real money.');
  }
  if (config.khaltiSecretKey && config.khaltiMode !== 'live' && !config.allowSandboxProvidersInProduction) {
    problems.push('KHALTI_MODE=test uses dev.khalti.com. Set KHALTI_MODE=live in production.');
  }
  if (config.esewaProductCode && config.esewaMode !== 'live' && !config.allowSandboxProvidersInProduction) {
    problems.push('ESEWA_MODE=test uses the eSewa sandbox. Set ESEWA_MODE=live in production.');
  }
  if (config.otpProvider === 'sandbox' && !config.allowSandboxProvidersInProduction) {
    problems.push('OTP_PROVIDER=sandbox is demo-only. Wire a real SMS provider before production.');
  }
  if (!['sandbox', 'twilio', 'webhook'].includes(config.otpProvider)) {
    problems.push('OTP_PROVIDER must be sandbox, twilio, or webhook.');
  }
  if (config.otpProvider === 'twilio') {
    if (!process.env.TWILIO_ACCOUNT_SID) problems.push('TWILIO_ACCOUNT_SID must be set when OTP_PROVIDER=twilio.');
    if (!process.env.TWILIO_AUTH_TOKEN) problems.push('TWILIO_AUTH_TOKEN must be set when OTP_PROVIDER=twilio.');
    if (!process.env.TWILIO_FROM_NUMBER) problems.push('TWILIO_FROM_NUMBER must be set when OTP_PROVIDER=twilio.');
  }
  if (config.otpProvider === 'webhook' && !process.env.SMS_WEBHOOK_URL) {
    problems.push('SMS_WEBHOOK_URL must be set when OTP_PROVIDER=webhook.');
  }
  if (config.emailProvider === 'sandbox' && !config.allowSandboxProvidersInProduction) {
    problems.push('EMAIL_PROVIDER=sandbox is demo-only. Set EMAIL_PROVIDER=resend, sendgrid, or webhook for password resets.');
  }
  if (!['sandbox', 'resend', 'sendgrid', 'webhook'].includes(config.emailProvider)) {
    problems.push('EMAIL_PROVIDER must be sandbox, resend, sendgrid, or webhook.');
  }
  if (['resend', 'sendgrid'].includes(config.emailProvider)) {
    if (!process.env.EMAIL_PROVIDER_API_KEY) problems.push(`EMAIL_PROVIDER_API_KEY must be set when EMAIL_PROVIDER=${config.emailProvider}.`);
    if (!process.env.EMAIL_FROM) problems.push(`EMAIL_FROM must be set when EMAIL_PROVIDER=${config.emailProvider}.`);
  }
  if (config.emailProvider === 'webhook' && !process.env.EMAIL_WEBHOOK_URL) {
    problems.push('EMAIL_WEBHOOK_URL must be set when EMAIL_PROVIDER=webhook.');
  }
  if (!config.publicAppUrl) {
    problems.push('PUBLIC_APP_URL must be set for payment callbacks, redirects, and deployment health checks.');
  }

  if (problems.length) {
    throw new Error(`Production configuration is incomplete:\n- ${problems.join('\n- ')}`);
  }
}

module.exports = { config, validateProductionConfig };
