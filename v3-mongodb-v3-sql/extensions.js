//Must manually specifiy the models that follow this connection - application for 'api::', 'plugins' for 'plugin::'
const modelsWithUuidAndDeleted = [
  'application::sqsp-oauth-requests.sqsp-oauth-requests',
  'application::subscription.subscription',
  'application::sk-memory.sk-memory',
  'application::plan.plan',
  'application::website.website',
  'application::sk-request.sk-request',
  'application::sk-token.sk-token',
  'plugins::users-permissions.user',
];

const modelsWithCreatedByUpdatedBy = [
  'application::sqsp-oauth-requests.sqsp-oauth-requests',
  'application::dashboard-content.dashboard-content',
  'application::subscription.subscription',
  'plugins::users-permissions.permission',
  'plugins::upload.file',
  'application::sk-memory.sk-memory',
  'application::plan.plan',
  'application::website.website',
  'application::sk-request.sk-request',
  'application::sk-token.sk-token',
  'plugins::users-permissions.role',
  'plugins::users-permissions.user',
];

const modelsToDrop = [
  'application::kicker.kicker',
  'application::help-and-support.help-and-support',
  'application::tutorials.tutorials',
  'application::ss-user.ss-user',
  'application::recent-updates.recent-updates'
];




module.exports = {
  modelsWithUuidAndDeleted,
  modelsWithCreatedByUpdatedBy,
  modelsToDrop
};
