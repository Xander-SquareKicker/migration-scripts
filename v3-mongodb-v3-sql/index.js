require('dotenv').config();

const _ = require('lodash');
const pluralize = require('pluralize');
const { singular } = pluralize;

const knex = require('./knex');
const schemaInspector = require('knex-schema-inspector').default;
const inspector = schemaInspector(knex);
const mongo = require('./mongo');
const { transformEntry } = require('./transform');
const idMap = require('./id-map');
const { modelsWithUuidAndDeleted, modelsWithCreatedByUpdatedBy, modelsToDrop } = require('./extensions');

/**
 * Combines 'pluginName'(if applicable) and 'content-type name' together to form a unique table name
 * @param {*} model core_store object
 * @param {*} modelName model.uid stripped of 'plugin::<plugin_name>.' or 'api::<api-name>.', or 'admin::'
 * @param {*} prefix plugin name - or 'component_'
 * @returns globally unique table name
 */
const getGlobalId = (model, modelName, prefix) => {
  let globalId = prefix ? `${prefix}-${modelName}` : modelName;

  return model.globalId || _.upperFirst(_.camelCase(globalId));
};

const getCollectionName = (associationA, associationB) => {
  if (associationA.dominant && _.has(associationA, 'collectionName')) {
    return associationA.collectionName;
  }

  if (associationB.dominant && _.has(associationB, 'collectionName')) {
    return associationB.collectionName;
  }

  return [associationA, associationB]
    .sort((a, b) => {
      if (a.collection === b.collection) {
        if (a.dominant) return 1;
        else return -1;
      }
      return a.collection < b.collection ? -1 : 1;
    })
    .map((table) => {
      return _.snakeCase(`${pluralize.plural(table.collection)}_${pluralize.plural(table.via)}`);
    })
    .join('__');
};

/**
 * Fetch content-type schema, and parse based on type
 * @param {*} db
 * @returns model information, plugin(e.g. admin, users-permissions), modelName (e.g. website, sk-token, user), globalID (unique model name)
 */
async function getModelDefs(db) {
  const coreStore = db.collection('core_store');

  /// SQUAREKICKER CUSTOMISATION
  const cursor = coreStore.find({
    key: { $regex: /^model_def/ },
  }).sort({$natural:-1});//Hot fix - 'Role' model must be handled BEFORE permissions, during relation creation
  /// END: SQUAREKICKER CUSTOMISATION

  const res = (await cursor.toArray())
    .map((item) => JSON.parse(item.value))
    .map((model) => {
      const { uid } = model;

      //Handle components
      if (!model.uid.includes('::')) {
        return {
          ...model,
          modelName: uid.split('.')[1],
          globalId: _.upperFirst(_.camelCase(`component_${uid}`)),
        };
      }

      let plugin;
      let apiName;
      let modelName;

      //UID format: '<type>::<api-name>.<conent-name>'
      if (uid.startsWith('strapi::')) {
        plugin = 'admin';
        modelName = uid.split('::')[1];
      } else if (uid.startsWith('plugins')) {
        plugin = uid.split('::')[1].split('.')[0];
        modelName = uid.split('::')[1].split('.')[1];
      } else if (uid.startsWith('application')) {
        apiName = uid.split('::')[1].split('.')[0];
        modelName = uid.split('::')[1].split('.')[1];
      }

      return {
        ...model,
        plugin,
        apiName,
        modelName,
        globalId: getGlobalId(model, modelName, plugin),
      };
    });

  await cursor.close();

  return res;
}

async function run() {
  const adminUserIdMap = {};

  try {
    //Setup DBs
    await mongo.connect();

    const db = mongo.db();

    let models = await getModelDefs(db);

    /// SQUAREKICKER CUSTOMISATION
    // RA Sewell 24.03.23
    // Merge models with same uid together. The different models with the same UID are created
    // because some data in the old (mongo) DB has multiple schemas in the same tables. This is
    // not possible in the SQL DB. We almost certainly want our new schema to reflect the schema
    // with the most attributes from the old DB, so we merge them together.
    // We can massage the schemas to be absolutely correct in the for...of loop below if necessary

    const sameKeys = (a1, a2) => {
      const b1 = a1.length > a2.length ? a1 : a2;
      const b2 = b1 === a1 ? a2 : a1;
      for (const k of b1) {
        if (b2.indexOf(k) === -1) return false;
      }
      return true;
    }

    models = models.reduce((acc, model) => {
      const existingModel = acc.find(m => m.uid === model.uid);
      if (existingModel) {
        const existingAttributes = existingModel.attributes;
        const existingModelKeys = Object.keys(existingModel).join(', ');
        const newModelKeys = Object.keys(model).join(', ');
        const existingModelAttributes = Object.keys(existingAttributes).join(', ');
        const newModelAttributes = Object.keys(model.attributes).join(', ');

        if (!sameKeys(existingModelKeys, newModelKeys)) {
          console.log(`Merging models for table: '${existingModel.uid}'`);
          console.log(`<== Existing Model [${existingModelKeys}]`);
          Object.assign(existingModel, model);
          console.log(`==> New model      [${Object.keys(existingModel).join(', ')}]`);
        }

        if (!sameKeys(existingModelAttributes, newModelAttributes)) {
          console.log(`Merging model attributes for table: '${existingModel.uid}'`);
          console.log(`<== Existing Attributes [${existingModelAttributes}]`);
          Object.assign(existingModel.attributes, existingAttributes, model.attributes);
          console.log(`==> New Attributes      [${Object.keys(existingModel.attributes).join(', ')}]`);
        }
      } else {
        if (!modelsToDrop.includes(model.uid)) {
          acc.push(model);
        } else {
          console.log (`Dropping table: ${model.uid}`);
        }

      }
      return acc;
    }, []);

    // Ensure the strapi administrator table is the first table so we can map created_by / updated_by
    const adminModel = models.find(m => m.uid === 'strapi::user');
    const adminModelIdx = models.indexOf(adminModel);
    models.splice(adminModelIdx, 1);
    models.unshift(adminModel);

    console.log('== FINAL MODELS ====================');
    for (const m of models) {
      console.log(m.uid)
    }
    console.log (`Table Count: ${models.length}`);
    console.log('====================================');


    /// END: SQUAREKICKER CUSTOMISATION


    //Map models to key/value pairs using uid name
    const modelMap = models.reduce((acc, model) => {
      acc[model.uid] = model;
      return acc;
    }, {});

    const dialect = require(`./dialects/${knex.client.config.client}`)(knex, inspector);
    await dialect.delAllTables(knex);
    await dialect.beforeMigration?.(knex);


    // 1st pass: for each document create a new row and store id in a map

    for (const model of models) {
      /// SQUAREKICKER CUSTOMISATION

      // RA Sewell 12.03.23
      // Drop any 'kickers' from any models as they are no longer supported
      if (model.attributes.kickers) {
        console.log(`Deleting 'kickers' from model '${model.uid}'`)
        delete model.attributes.kickers;
      }
      // Drop any 'ss_users' from any models as they are no longer supported
      if (model.attributes.ss_users) {
        console.log(`Deleting 'ss_users' from model '${model.uid}'`)
        delete model.attributes.ss_users;
      }

      // TODO - skip already imported tables... (for testing only)
      // switch (model.uid) {
      //   case 'application::sqsp-oauth-requests.sqsp-oauth-requests':
      //   case 'application::dashboard-content.dashboard-content':
      //   case 'application::subscription.subscription':
      //   case 'plugins::users-permissions.permission':
      //   case 'plugins::upload.file':
      //   case 'strapi::webhooks':
      //   case 'application::sk-memory.sk-memory':
      //   case 'application::plan.plan':
      //   case 'application::website.website':
      //   case 'application::sk-request.sk-request':
      //   case 'strapi::core-store':
      //   case 'application::sk-token.sk-token':
      //   case 'plugins::users-permissions.role':
      //   case 'strapi::role':
      //   case 'plugins::users-permissions.user':
      //   // case 'strapi::permission':
      //   // _case 'strapi::user':
      //   // _case 'application::help-and-support.help-and-support':
      //   // _case 'application::tutorials.tutorials':
      //   // _case 'application::ss-user.ss-user':
      //   // _case 'application::recent-updates.recent-updates':
      //     console.log(`Skipping '${model.uid}' table`);
      //     continue;
      //   default:
      //     //
      // }

      // RA Sewell 24.03.23
      // Fix uuid / deleted attributes in all tables where they should exist
      if(modelsWithUuidAndDeleted.includes(model.uid)) {
        model.attributes['uuid'] = {
          type: 'uid'
        }
        model.attributes['deleted'] = {
          type: 'boolean',
          default: false,
        }
      }

      // RA Sewell 24.03.23
      // Fix created_by / updated_by attributes in all tables where they should exist
      if(modelsWithCreatedByUpdatedBy.includes(model.uid)) {
        model.attributes['created_by'] = {
          type: 'integer'
        }
        model.attributes['updated_by'] = {
          type: 'integer',
        }
      }


      // RA Sewell 24.03.23
      // Fix attributes in all tables where they are not correctly auto-detected
      // if (model.uid === 'application::sqsp-oauth-requests.sqsp-oauth-requests') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'application::dashboard-content.dashboard-content') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'application::subscription.subscription') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'plugins::users-permissions.permission') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'plugins::upload.file') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'strapi::webhooks') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'application::sk-memory.sk-memory') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'application::website.website') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'application::sk-request.sk-request') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'strapi::core-store') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'application::sk-token.sk-token') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'plugins::users-permissions.role') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'strapi::role') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'plugins::users-permissions.user') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      if (model.uid === 'strapi::permission') {
        console.log(`Fixing model for the table: ${model.uid}`);
        // Remove legacy fields attribute
        delete model.attributes.fields;
      }
      // else if (model.uid === 'strapi::user') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      // }
      // else if (model.uid === 'application::help-and-support.help-and-support') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      //   //
      // }
      // else if (model.uid === 'application::tutorials.tutorials') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      //   //
      // }
      // else if (model.uid === 'application::ss-user.ss-user') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      //   //
      // }
      // else if (model.uid === 'application::recent-updates.recent-updates') {
      //   console.log(`Fixing model for the table: ${model.uid}`);
      //   //
      // }


      let totalCount = await db.collection(model.collectionName).countDocuments();
      console.log("Parsing", model.uid, `with ${totalCount} documents`)

      const cursor = db.collection(model.collectionName).find()
      let rowCount = 0;
      while (await cursor.hasNext()) {
        const entry = await cursor.next();


        const row = transformEntry(entry, model, adminUserIdMap);
        row.id = idMap.next(entry._id, model.collectionName);

        // RA Sewell 23.03.23 - build the adminUserIdMap
        if (model.uid === 'strapi::user') {
          adminUserIdMap[entry._id] = row.id;
        }

        // RA Sewell 23.03.23 - print the row entity that failed
        try {
          await knex(model.collectionName).insert(row);
        } catch(e) {
          console.log(`Failed to insert into collection: ${model.collectionName}`);
          console.log(JSON.stringify(row, null, 2))
          throw e;
        }

        rowCount++;
      }
      console.log(`Inserted ${rowCount}/${totalCount}`)
      await cursor.close();

      /// END: SQUAREKICKER CUSTOMISATION
    }

    // 2nd pass: for each document's components & relations create the links in the right tables
    console.log("Filling in relations...")
    for (const model of models) {
    // if (false) {
      const cursor = db.collection(model.collectionName).find();

      while (await cursor.hasNext()) {
        const entry = await cursor.next();

        for (const key of Object.keys(entry)) {
          const attribute = model.attributes[key];

          if (!attribute) {
            continue;
          }

          if (attribute.type === 'component') {
            // create compo links
            const componentModel = modelMap[attribute.component];
            const linkTableName = `${model.collectionName}_components`;

            const rows = entry[key].map((mongoLink, idx) => {
              return {
                id: idMap.next(mongoLink._id, linkTableName),
                field: key,
                order: idx + 1,
                component_type: componentModel.collectionName,
                component_id: idMap.get(mongoLink.ref),
                [`${singular(model.collectionName)}_id`]: idMap.get(entry._id),
              };
            });

            if (rows.length > 0) {
              await knex(linkTableName).insert(rows);
            }

            continue;
          }

          if (attribute.type === 'dynamiczone') {
            // create compo links
            const linkTableName = `${model.collectionName}_components`;

            const rows = entry[key].map((mongoLink, idx) => {
              const componentModel = models.find((m) => m.globalId === mongoLink.kind);

              return {
                id: idMap.next(mongoLink._id, linkTableName),
                field: key,
                order: idx + 1,
                component_type: componentModel.collectionName,
                component_id: idMap.get(mongoLink.ref),
                [`${singular(model.collectionName)}_id`]: idMap.get(entry._id),
              };
            });

            if (rows.length > 0) {
              await knex(linkTableName).insert(rows);
            }

            continue;
          }

          //Single file model
          if (attribute.model === 'file' && attribute.plugin === 'upload') {
            if (!entry[key]) {
              continue;
            }

            const row = {
              upload_file_id: idMap.get(entry[key]),
              related_id: idMap.get(entry._id),
              related_type: model.collectionName,
              field: key,
              order: 1,
            };

            await knex('upload_file_morph').insert(row);
          }

          //Multiple files
          if (attribute.collection === 'file' && attribute.plugin === 'upload') {
            const rows = entry[key].map((e, idx) => ({
              upload_file_id: idMap.get(e),
              related_id: idMap.get(entry._id),
              related_type: model.collectionName,
              field: key,
              order: idx + 1,
            }));

            if (rows.length > 0) {
              await knex('upload_file_morph').insert(rows);
            }
          }

          if (attribute.model || attribute.collection) {
            // create relation links

            const targetModel = models.find((m) => {
              return (
                [attribute.model, attribute.collection].includes(m.modelName) &&
                (!attribute.plugin || (attribute.plugin && attribute.plugin === m.plugin))
              );
            });

            const targetAttribute = targetModel?.attributes?.[attribute.via];

            const isOneWay = attribute.model && !attribute.via && attribute.model !== '*';
            const isOneToOne =
              attribute.model &&
              attribute.via &&
              targetAttribute?.model &&
              targetAttribute?.model !== '*';
            const isManyToOne =
              attribute.model &&
              attribute.via &&
              targetAttribute?.collection &&
              targetAttribute?.collection !== '*';
            const isOneToMany =
              attribute.collection &&
              attribute.via &&
              targetAttribute?.model &&
              targetAttribute?.model !== '*';
            const isManyWay =
              attribute.collection && !attribute.via && attribute.collection !== '*';
            const isMorph = attribute.model === '*' || attribute.collection === '*';

            // TODO: check dominant side
            const isManyToMany =
              attribute.collection &&
              attribute.via &&
              targetAttribute?.collection &&
              targetAttribute?.collection !== '*';

            if (isOneWay || isOneToOne || isManyToOne) {
              // TODO: optimize with one updata at the end

              if (!entry[key]) {
                continue;
              }

              await knex(model.collectionName)
                .update({
                  [key]: idMap.get(entry[key]),
                })
                .where('id', idMap.get(entry._id));

              continue;
            }

            if (isOneToMany) {
              // nothing to do
              continue;
            }

            if (isManyWay) {
              const joinTableName =
                attribute.collectionName || `${model.collectionName}__${_.snakeCase(key)}`;

              const fk = `${singular(model.collectionName)}_id`;
              let otherFk = `${singular(attribute.collection)}_id`;

              if (otherFk === fk) {
                otherFk = `related_${otherFk}`;
              }

              const rows = entry[key].map((id) => {
                return {
                  [otherFk]: idMap.get(id),
                  [fk]: idMap.get(entry._id),
                };
              });

              if (rows.length > 0) {
                await knex(joinTableName).insert(rows);
              }

              continue;
            }

            if (isManyToMany) {
              if (attribute.dominant) {
                const joinTableName = getCollectionName(attribute, targetAttribute);

                let fk = `${singular(targetAttribute.collection)}_id`;
                let otherFk = `${singular(attribute.collection)}_id`;

                if (otherFk === fk) {
                  fk = `${singular(attribute.via)}_id`;
                }

                const rows = entry[key].map((id) => {
                  return {
                    [otherFk]: idMap.get(id),
                    [fk]: idMap.get(entry._id),
                  };
                });

                if (rows.length > 0) {
                  await knex(joinTableName).insert(rows);
                }
              }

              continue;
            }

            continue;
          }

          // get relations
        }
      }

      await cursor.close();

      await dialect.afterMigration?.(knex);
    }
  } finally {
    await mongo.close();
    await knex.destroy();
  }

  console.log('Done');
}

run().catch(console.dir);
