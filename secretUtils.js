/*  secretUtils.js
 * Copyright (C) 2025  Daniel K. O.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const Gio    = imports.gi.Gio;
const Secret = imports.gi.Secret;


// strings will be translated by gettext in the frontend
const _ = x => x;


Gio._promisify(Secret, 'password_clear', 'password_clear_finish');
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_search', 'password_search_finish');
Gio._promisify(Secret, 'password_store', 'password_store_finish');
Gio._promisify(Secret.Collection, 'create', 'create_finish');
Gio._promisify(Secret.Item.prototype, 'set_attributes', 'set_attributes_finish');
Gio._promisify(Secret.Item.prototype, 'set_label', 'set_label_finish');
Gio._promisify(Secret.Item.prototype, 'set_secret', 'set_secret_finish');
Gio._promisify(Secret.Service, 'get', 'get_finish');
Gio._promisify(Secret.Service.prototype, 'search', 'search_finish');
Gio._promisify(Secret.Service.prototype, 'lock', 'lock_finish');
Gio._promisify(Secret.Service.prototype, 'unlock', 'unlock_finish');


const OTP_COLLECTION_DBUS_PATH = '/org/freedesktop/secrets/collection/OTP';


function makeSchemaTOTP()
{
    return new Secret.Schema('org.gnome.shell.extensions.totp',
                             Secret.SchemaFlags.NONE,
                             {
                                 type      : Secret.SchemaAttributeType.STRING,
                                 issuer    : Secret.SchemaAttributeType.STRING,
                                 name      : Secret.SchemaAttributeType.STRING,
                                 digits    : Secret.SchemaAttributeType.INTEGER,
                                 period    : Secret.SchemaAttributeType.INTEGER,
                                 algorithm : Secret.SchemaAttributeType.STRING
                             });
}


function makeSchemaHOTP()
{
    return new Secret.Schema('org.gnome.shell.extensions.totp',
                             Secret.SchemaFlags.NONE,
                             {
                                 type      : Secret.SchemaAttributeType.STRING,
                                 issuer    : Secret.SchemaAttributeType.STRING,
                                 name      : Secret.SchemaAttributeType.STRING,
                                 digits    : Secret.SchemaAttributeType.INTEGER,
                                 counter   : Secret.SchemaAttributeType.INTEGER,
                                 algorithm : Secret.SchemaAttributeType.STRING
                             });
}


function makeSchemaFor(otp)
{
    if (otp.type == 'TOTP')
        return makeSchemaTOTP();
    if (otp.type == 'HOTP')
        return makeSchemaHOTP();
    throw new Error(`BUG: otp.type is ${otp.type}`);
}


async function findOTPCollection()
{
    const service = await Secret.Service.get(Secret.ServiceFlags.LOAD_COLLECTIONS, null);
    const collections = service.get_collections();
    // look for the 'OTP' at the hardcoded path
    for (let i = 0; i < collections.length; ++i)
        if (collections[i].get_object_path() == OTP_COLLECTION_DBUS_PATH)
            return [service, collections[i]];
    return [service, null];
}


async function ensureCollection()
{
    let [service, collection] = await findOTPCollection();
    if (collection)
        return;

    // could not find it, so create one
    await Secret.Collection.create(service,
                                   'OTP',
                                   null,
                                   Secret.CollectionCreateFlags.NONE,
                                   null);
}


async function isOTPCollectionLocked()
{
    // force a new connection, so we get reliable lock status
    Secret.Service.disconnect();
    const [service, collection] = await findOTPCollection();
    if (!collection)
        return false;
    return collection.locked;
}


async function lockOTPCollection()
{
    const [service, collection] = await findOTPCollection();
    if (!collection)
        return false;
    return await service.lock([collection], null) > 0;
}


async function unlockOTPCollection()
{
    const [service, collection] = await findOTPCollection();
    if (!collection)
        return false;
    return await service.unlock([collection], null) > 0;
}


function getOrder(label)
{
    const [token] = label.split(':', 1);
    if (!token)
        return 0;
    const value = parseFloat(token);
    if (isNaN(value))
        return 0;
    return value;
}


async function getOTPItems(unlock = false)
{
    try {
        let flags = Secret.SearchFlags.ALL;
        if (unlock)
            flags |= Secret.SearchFlags.UNLOCK;
        const totp_items = await Secret.password_search(makeSchemaTOTP(),
                                                        { type: 'TOTP' },
                                                        flags,
                                                        null);
        const hotp_items = await Secret.password_search(makeSchemaHOTP(),
                                                        { type: 'HOTP' },
                                                        flags,
                                                        null);
        // return them sorted, using the label
        const items = totp_items.concat(hotp_items);
        items.sort((a, b) => getOrder(a.get_label()) - getOrder(b.get_label()));
        return items;
    }
    catch (e) {
        return [];
    }
}


async function getOTPItem(otp)
{
    let match = makeAttributesFor(otp);
    if (otp.type == 'HOTP')
        delete match.counter; // don't match the counter
    const [item] = await Secret.password_search(makeSchemaFor(otp),
                                                match,
                                                Secret.SearchFlags.LOAD_SECRETS, // don't unlock
                                                null);
    if (!item)
        throw new Error(_('Failed to lookup secret.'));
    return item;
}


// libsecret wants the attributes to all be strings
function makeAttributesFor(otp)
{
    if (otp.type == 'TOTP')
        return {
            type: 'TOTP',
            issuer: otp.issuer,
            name: otp.name,
            digits: otp.digits.toString(),
            period: otp.period.toString(),
            algorithm: otp.algorithm
        };
    if (otp.type == 'HOTP')
        return {
            type: 'HOTP',
            issuer: otp.issuer,
            name: otp.name,
            digits: otp.digits.toString(),
            counter: otp.counter.toString(),
            algorithm: otp.algorithm
        };
    throw new Error(`BUG: otp.type is "${otp.type}"`);
}


function makeLabelFor({issuer, name}, order = -1)
{
    const prefix = order > -1 ? order : "-";
    return `${prefix}:${issuer}:${name}`;
}


async function getSecret(otp)
{
    const match = makeAttributesFor(otp);
    if (otp.type == 'HOTP')
        delete match.counter;
    const secret = await Secret.password_lookup(makeSchemaFor(otp),
                                                match,
                                                null);
    if (secret == null) {
        throw new Error(_('Failed to retrieve secret.'));
    }
    return secret;
}


function equalDictionaries(a, b)
{
    const ak = Object.keys(a);
    const bk = Object.keys(b);

    if (ak.length != bk.length)
        return false;

    for (let k of ak)
        if (a[k] !== b[k])
            return false;
    return true;
}


async function updateOTPItem(old_otp, new_otp)
{
    const service = await Secret.Service.get(
        Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS,
        null);
    const old_attr = makeAttributesFor(old_otp);
    const match = {...old_attr};
    if (old_otp.type == 'HOTP')
        delete match.counter; // don't match the counter
    const [item] = await service.search(makeSchemaFor(old_otp),
                                        match,
                                        Secret.SearchFlags.UNLOCK
                                        | Secret.SearchFlags.LOAD_SECRETS,
                                        null);
    if (!item)
        throw new Error(_('Failed to lookup item.'));

    // check if label changed
    const old_label = item.get_label();
    const new_label = makeLabelFor(new_otp, getOrder(old_label));
    if (old_label != new_label)
        if (!await item.set_label(new_label, null))
            throw new Error(_('Failed to set label.'));

    // check if attributes changed
    const new_attr = makeAttributesFor(new_otp);

    if (!equalDictionaries(old_attr, new_attr))
        if (!await item.set_attributes(makeSchemaFor(new_otp), new_attr, null))
            throw new Error(_('Failed to set attributes.'));

    // check if secret changed
    if (old_otp.secret != new_otp.secret) {
        const secret_value = new Secret.Value(new_otp.secret, -1, "text/plain");
        if (!await item.set_secret(secret_value, null))
            throw new Error(_('Failed to set secret.'));
    }
}


async function updateOTPOrder(otp, order)
{
    const service = await Secret.Service.get(
        Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS,
        null);
    const match = makeAttributesFor(otp);
    if (otp.type == 'HOTP')
        delete match.counter;
    const [item] = await service.search(makeSchemaFor(otp),
                                        match,
                                        Secret.SearchFlags.NONE,
                                        null);
    if (!item)
        throw new Error(_('Failed to lookup item.'));

    const old_label = item.get_label();
    const new_label = makeLabelFor(otp, order);
    if (new_label == old_label)
        return;
    if (!await item.set_label(new_label, null))
        throw new Error(_('Failed to set label.'));
}


async function incrementHOTP(otp)
{
    const service = await Secret.Service.get(
        Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS,
        null);
    const match = makeAttributesFor(otp);
    delete match.counter;
    const [item] = await service.search(makeSchemaFor(otp),
                                        match,
                                        Secret.SearchFlags.NONE,
                                        null);
    if (!item)
        throw new Error(_('Failed to lookup item.'));

    const old_counter = parseInt(item.get_attributes().counter);
    const new_counter = old_counter + 1;
    const new_attr = makeAttributesFor(otp);
    new_attr.counter = new_counter.toString();
    if (!await item.set_attributes(makeSchemaFor(otp),
                                   new_attr,
                                   null))
        throw new Error(_('Failed to set counter.'));
    return new_counter;
}

async function createOTPItem(otp, order)
{
    await ensureCollection();
    return await Secret.password_store(makeSchemaFor(otp),
                                       makeAttributesFor(otp),
                                       OTP_COLLECTION_DBUS_PATH,
                                       makeLabelFor(otp, order),
                                       otp.secret,
                                       null);
}


async function removeOTPItem(otp)
{
    return await Secret.password_clear(makeSchemaFor(otp),
                                       makeAttributesFor(otp),
                                       null);
}
