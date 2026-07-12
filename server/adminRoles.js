// Role-based access control for the staff/admin portal.
// superadmin — everything, including managing other admins
// ops        — review listings and business KYC
// finance    — review withdrawals / payouts
// support    — read-only dashboards
const ROLES = {
  superadmin: ['*'],
  ops: ['read', 'listings.review', 'kyc.review'],
  finance: ['read', 'payments.review'],
  support: ['read']
};

function isRole(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role);
}

function can(role, permission) {
  const perms = ROLES[role];
  if (!perms) return false;
  return perms.includes('*') || perms.includes(permission);
}

module.exports = { ROLES, isRole, can };
