const _ = require('lodash/fp');
const {
  modelsWithUuidAndDeleted,
} = require('./extensions');


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

function transformEntry(entry, model, adminUserIdMap) {
   // transform attributes
  const res = {};

  /// SQUAREKICKER CUSTOMISATION
  //Populate custom sql field - Uuid field does not exist in mongo
  if(modelsWithUuidAndDeleted.includes(model.uid)) {
    entry.uuid = entry._id.toString();
    entry.deleted = entry.deleted || false;
  }

  // RA Sewell 24.03.23
  // Map the created_by / updated_by ids
  if (entry.created_by) {
    const v = adminUserIdMap[entry.created_by];
    if (v) {
      entry.created_by = v;
    }
  }
  if (entry.updated_by) {
    const v = adminUserIdMap[entry.updated_by];
    if (v) {
      entry.updated_by = v;
    }
  }

  // RA Sewell 23.03.23
  // Fix entries in the subscription table
  if (model.uid === 'application::subscription.subscription') {
    if (entry.activationDate === '') {
      entry.activationDate = null;
    }
  }


  // RA Sewell 12.03.23
  // Ensure all required fields exist in all data, adding fields that don't exist
  for ([attrKey,attrValue] of Object.entries(model.attributes)) {
    if (attrValue.required) {
      const entryHasAttribute = Object.prototype.hasOwnProperty.call(entry, attrKey);
      const modelHasDefault = Object.prototype.hasOwnProperty.call(attrValue, 'default');
      if (!entryHasAttribute) {
        // The attribute is required, but the entry has no attribute - set the default
        if (modelHasDefault) {
          console.log(`Adding missing attribute '${attrKey}' to entry '${entry._id}' of '${model.uid}'`)
          entry[attrKey] = attrValue.default;
        } else {
          throw new Error(`Entry '${entry._id}' of '${model.uid}' is missing required model attribute '${attrKey}', and there is no default`, model, entry);
        }
      }
    }
  }

  // RA Sewell 12.03.23
  // Drop any 'kickers' relations from any tables as they are no longer supported
  if (entry.kickers) {
    console.log(`Deleting 'kickers' from entry '${entry._id}' of '${model.uid}'`)
    delete entry.kickers;
  }

  /// END: SQUAREKICKER CUSTOMISATION


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
