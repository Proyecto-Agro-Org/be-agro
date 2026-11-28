// Declarative DDL specifications for an EMPTY, explicitly authorized catalogue.
// Exporting these values does not create/alter any collection or index.
const key = { bsonType: 'string', minLength: 1, maxLength: 256 };
const version = { bsonType: ['int', 'long', 'double'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 };
const realm = { enum: ['development', 'test', 'preview', 'production'] };
const membership = { bsonType: ['object', 'null'], additionalProperties: false,
  required: ['clientId', 'active', 'updatedAt', 'clientSecurityVersion'],
  properties: { clientId: key, active: { bsonType: 'bool' }, updatedAt: { bsonType: 'date' }, clientSecurityVersion: version } };
export const catalogueCollectionValidators = {
  users: { $jsonSchema: { bsonType: 'object', additionalProperties: false,
    required: ['_id', 'realm', 'id', 'issuer', 'subject', 'name', 'email', 'active', 'securityVersion', 'updatedAt', 'membership'],
    properties: { _id: { bsonType: 'string', minLength: 1, maxLength: 300 }, realm, id: key,
      issuer: { enum: ['https://accounts.google.com'] }, subject: key, name: key,
      email: { bsonType: 'string', minLength: 3, maxLength: 320 }, active: { bsonType: 'bool' },
      securityVersion: version, updatedAt: { bsonType: 'date' }, membership } } },
  clients: { $jsonSchema: { bsonType: 'object', additionalProperties: false,
    required: ['_id', 'realm', 'id', 'name', 'active', 'securityVersion', 'updatedAt'],
    properties: { _id: { bsonType: 'string', minLength: 1, maxLength: 300 }, realm, id: key, name: key,
      active: { bsonType: 'bool' }, securityVersion: version, updatedAt: { bsonType: 'date' } } } },
};
