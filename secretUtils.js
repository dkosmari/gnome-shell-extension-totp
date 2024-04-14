/*  secretUtils.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


import Gio    from 'gi://Gio';
import Secret from 'gi://Secret';


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


function makeSchema()
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


export
async function isOTPCollectionLocked()
{
    // force a new connection, so we get reliable lock status
    Secret.Service.disconnect();
    const [service, collection] = await findOTPCollection();
    if (!collection)
        return false;
    return collection.locked;
}


export
async function lockOTPCollection()
{
    const [service, collection] = await findOTPCollection();
    if (!collection)
        return false;
    return await service.lock([collection], null) > 0;
}


export
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


export
async function getOTPItems(unlock = false)
{
    try {
        let flags = Secret.SearchFlags.ALL;
        if (unlock)
            flags |= Secret.SearchFlags.UNLOCK;
        const items = await Secret.password_search(makeSchema(),
                                                   { type: 'TOTP' },
                                                   flags,
                                                   null);
        // return them sorted, using the label
        items.sort((a, b) => getOrder(a.get_label()) - getOrder(b.get_label()));
        return items;
    }
    catch (e) {
        return [];
    }
}


export
async function getOTPItem(totp)
{
    const [item] = await Secret.password_search(makeSchema(),
                                                makeAttributes(totp),
                                                Secret.SearchFlags.LOAD_SECRETS, // don't unlock
                                                null);
    if (!item)
        throw new Error(_('Failed to lookup secret.'));
    return item;
}


// libsecret wants the attributes to all be strings
function makeAttributes({issuer, name, digits, period, algorithm})
{
    return {
        type: 'TOTP',
        issuer: issuer,
        name: name,
        digits: digits.toString(),
        period: period.toString(),
        algorithm: algorithm
    };
}


function makeLabel({issuer, name}, order = -1)
{
    const prefix = order > -1 ? order : "-";
    return `${prefix}:${issuer}:${name}`;
}


export
async function getSecret(args)
{
    const secret = await Secret.password_lookup(makeSchema(),
                                                makeAttributes(args),
                                                null);
    if (secret == null)
        throw new Error(_('Failed to retrieve secret.'));
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


export
async function updateTOTPItem(old_totp, new_totp)
{
    const service = await Secret.Service.get(
        Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS,
        null);
    const old_attributes = makeAttributes(old_totp);
    const [item] = await service.search(makeSchema(),
                                        old_attributes,
                                        Secret.SearchFlags.UNLOCK
                                        | Secret.SearchFlags.LOAD_SECRETS,
                                        null);
    if (!item)
        throw new Error(_('Failed to lookup item.'));

    // check if label changed
    const old_label = item.get_label();
    const new_label = makeLabel(new_totp, getOrder(old_label));
    if (old_label != new_label)
        if (!await item.set_label(new_label, null))
            throw new Error(_('Failed to set label.'));

    // check if attributes changed
    const new_attributes = makeAttributes(new_totp);

    if (!equalDictionaries(old_attributes, new_attributes))
        if (!await item.set_attributes(makeSchema(), new_attributes, null))
            throw new Error(_('Failed to set attributes.'));

    // check if secret changed
    if (old_totp.secret != new_totp.secret) {
        const secret_value = new Secret.Value(new_totp.secret, -1, "text/plain");
        if (!await item.set_secret(secret_value, null))
            throw new Error(_('Failed to set secret.'));
    }
}


export
async function updateTOTPOrder(totp, order)
{
    const service = await Secret.Service.get(
        Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS,
        null);
    const [item] = await service.search(makeSchema(),
                                        makeAttributes(totp),
                                        Secret.SearchFlags.NONE,
                                        null);
    if (!item)
        throw new Error(_('Failed to lookup item.'));

    const old_label = item.get_label();
    const new_label = makeLabel(totp, order);
    if (new_label == old_label)
        return;
    if (!await item.set_label(new_label, null))
        throw new Error(_('Failed to set label.'));
}


export
async function createTOTPItem(totp, order)
{
    await ensureCollection();
    return await Secret.password_store(makeSchema(),
                                       makeAttributes(totp),
                                       OTP_COLLECTION_DBUS_PATH,
                                       makeLabel(totp, order),
                                       totp.secret,
                                       null);
}


export
async function removeTOTPItem(totp)
{
    return await Secret.password_clear(makeSchema(),
                                       makeAttributes(totp),
                                       null);
}
