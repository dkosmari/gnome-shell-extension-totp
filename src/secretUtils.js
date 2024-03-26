/*  secretUtils.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const {
    Gio,
    Secret
} = imports.gi;


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
    let service = await Secret.Service.get(Secret.ServiceFlags.LOAD_COLLECTIONS, null);
    let collections = service.get_collections();
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
    let [service, collection] = await findOTPCollection();
    if (!collection)
        return false;
    return collection.locked;
}


async function lockOTPCollection()
{
    let [service, collection] = await findOTPCollection();
    if (!collection)
        return false;
    return await service.lock([collection], null) > 0;
}


async function unlockOTPCollection()
{
    let [service, collection] = await findOTPCollection();
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


async function getOTPItems()
{
    try {
        let items = await Secret.password_search(makeSchema(),
                                                 { type: 'TOTP' },
                                                 Secret.SearchFlags.ALL,
                                                 null);
        // return them sorted, using the label
        items.sort((a, b) => getOrder(a.get_label()) - getOrder(b.get_label()));
        return items;
    }
    catch (e) {
        return [];
    }
}


async function getOTPItem(totp)
{
    let [item] = await Secret.password_search(makeSchema(),
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
    let prefix = "-";
    if (order > -1)
        prefix = order.toString();
    return `${prefix}:${issuer}:${name}`;
}


async function getSecret(args)
{
    let secret = await Secret.password_lookup(makeSchema(),
                                              makeAttributes(args),
                                              null);
    if (!secret)
        throw new Error(_('Failed to retrieve secret.'));
    return secret;
}


function equalDictionaries(a, b)
{
    let ak = Object.keys(a);
    let bk = Object.keys(b);

    if (ak.length != bk.length)
        return false;

    for (let k of ak)
        if (a[k] !== b[k])
            return false;
    return true;
}


async function updateTOTPItem(old_totp, new_totp)
{
    let service = await Secret.Service.get(
        Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS,
        null);
    let old_attributes = makeAttributes(old_totp);
    let [item] = await service.search(makeSchema(),
                                      old_attributes,
                                      Secret.SearchFlags.UNLOCK
                                      | Secret.SearchFlags.LOAD_SECRETS,
                                      null);
    if (!item)
        throw new Error(_('Failed to lookup secret.'));

    // check if label changed
    let old_label = item.get_label();
    let new_label = makeLabel(new_totp, getOrder(old_label));
    if (old_label != new_label)
        if (!await item.set_label(new_label, null))
            throw new Error(_('Failed to set label.'));

    // check if attributes changed
    let new_attributes = makeAttributes(new_totp);

    if (!equalDictionaries(old_attributes, new_attributes))
        if (!await item.set_attributes(makeSchema(), new_attributes, null))
            throw new Error(_('Failed to set attributes.'));

    // check if secret changed
    if (old_totp.secret != new_totp.secret) {
        let secret_value = new Secret.Value(new_totp.secret, -1, "text/plain");
        if (!await item.set_secret(secret_value, null))
            throw new Error(_('Failed to set secret.'));
    }
}


async function updateTOTPOrder(totp, order)
{
    let service = await Secret.Service.get(
        Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS,
        null);
    let [item] = await service.search(makeSchema(),
                                      makeAttributes(totp),
                                      Secret.SearchFlags.NONE,
                                      null);
    if (!item)
        throw new Error(_('Failed to lookup secret.'));

    if (!await item.set_label(makeLabel(totp, order), null))
        throw new Error(_('Failed to set label.'));
}


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


async function removeTOTPItem(totp)
{
    return await Secret.password_clear(makeSchema(),
                                       makeAttributes(totp),
                                       null);
}
