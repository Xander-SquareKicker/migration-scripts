const _ = require('lodash/fp');

//Must manually specifiy the models that follow this connection - application for 'api::', 'plugins' for 'plugin::'
const modelsWithUuid = ["application::website.website", "application::plan.plan", "application::sk-token.sk-token", "application::sk-request.sk-request", "application::sk-memory.sk-memory", "plugins::users-permissions.user"]
const modelsWithDeleted = ["application::website.website", "application::plan.plan", "application::sk-token.sk-token", "application::sk-request.sk-request", "application::sk-memory.sk-memory", "plugins::users-permissions.user"]

const isScalar = (attribute) =>
  _.has('type', attribute) && !['component', 'dynamiczone'].includes(attribute.type);

const DEFAULT_TIMESTAMPS = ['createdAt', 'updatedAt'];
const getTimestampKeys = (model) => {
  const tsOption = _.getOr(DEFAULT_TIMESTAMPS, 'options.timestamps', model);

  if (tsOption === true) {
    return DEFAULT_TIMESTAMPS;
  }

  if (tsOption === false) {
    return [];
  }

  if (!Array.isArray(tsOption) || tsOption.length != 2) {
    throw new Error(`Expected model.options.timestamps to be true or an array with 2 string`);
  }

  return tsOption;
};

function transformEntry(entry, model) {
   // transform attributes
  const res = {};

  /// SQUAREKICKER CUSTOMISATION
  //Populate custom sql field - Uuid field does not exist in mongo
  if(modelsWithUuid.includes(model.uid))
    res['uuid'] = entry._id.toString();

  if(modelsWithDeleted.includes(model.uid))
    res['deleted'] = entry.deleted || false;
/// SQUAREKICKER CUSTOMISATION


  const [createdAtKey, updatedAtKey] = getTimestampKeys(model);

  if (createdAtKey) {
    res.created_at = entry[createdAtKey];
  }

  if (updatedAtKey) {
    res.updated_at = entry[updatedAtKey];
  }
  //Looks through via 'model' attributes perspective
  Object.entries(model.attributes).forEach(([key, attribute]) => {
    if (isScalar(attribute)) {
      
      /// SQUAREKICKER CUSTOMISATION
      if(!Object.keys(entry).includes(key)){//Handle missing 'default' values
        if(attribute.default && attribute.type === 'json') res[key] = JSON.stringify(attribute.default)
        else if (attribute.default) res[key] = attribute.default;
        return;
      }
      /// SQUAREKICKER CUSTOMISATION  

      if (attribute.type === 'json') {
        res[key] = JSON.stringify(entry[key]);
        return;
      }

      res[key] = entry[key];
    }
  });

  return res;
}

module.exports = {
  transformEntry,
};
