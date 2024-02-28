/*  secretUtils.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const {Gio, GLib, Secret} = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;

const _ = ExtensionUtils.gettext;


Gio._promisify(Secret, 'password_clear', 'password_clear_finish');
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_search', 'password_search_finish');
Gio._promisify(Secret, 'password_store', 'password_store_finish');
Gio._promisify(Secret.Collection, 'create');
Gio._promisify(Secret.Item.prototype, 'set_attributes', 'set_attributes_finish');
Gio._promisify(Secret.Item.prototype, 'set_label', 'set_label_finish');
Gio._promisify(Secret.Item.prototype, 'set_secret', 'set_secret_finish');
Gio._promisify(Secret.Service, 'get', 'get_finish');
Gio._promisify(Secret.Service.prototype, 'search', 'search_finish');


let SCHEMA = new Secret.Schema('org.gnome.shell.extensions.totp',
                               Secret.SchemaFlags.NONE,
                               {
                                   type      : Secret.SchemaAttributeType.STRING,
                                   issuer    : Secret.SchemaAttributeType.STRING,
                                   name      : Secret.SchemaAttributeType.STRING,
                                   digits    : Secret.SchemaAttributeType.INTEGER,
                                   period    : Secret.SchemaAttributeType.INTEGER,
                                   algorithm : Secret.SchemaAttributeType.STRING
                               });


let OTP_COLLECTION = '/org/freedesktop/secrets/collection/OTP';


async function ensureCollection()
{
    let service = await Secret.Service.get(Secret.ServiceFlags.LOAD_COLLECTIONS, null);
    let collections = service.get_collections();
    // look for a collection called 'OTP'
    for (let i = 0; i < collections.length; ++i)
        if (collections[i].label == 'OTP')
            return;

    // could not find it, so create one
    await Secret.Collection.create(service,
                                   'OTP',
                                   null,
                                   Secret.CollectionCreateFlags.NONE,
                                   null);
}


function ensureCollectionSync()
{
    let service = Secret.Service.get_sync(Secret.ServiceFlags.LOAD_COLLECTIONS, null);
    let collections = service.get_collections();
    for (let i = 0; i < collections.length; ++i)
        if (collections[i].label == 'OTP')
            return;
    // could not find it, so create one
    let c = Secret.Collection.create_sync(service,
                                          'OTP',
                                          null,
                                          Secret.CollectionCreateFlags.NONE,
                                          null);
}


async function getList()
{
    try {
        return await Secret.password_search(SCHEMA,
                                            { type: 'TOTP' },
                                            Secret.SearchFlags.ALL,
                                            null);
    }
    catch (e) {
        return [];
    }
}


function getListSync()
{
    return Secret.password_search_sync(SCHEMA,
                                       { type: 'TOTP' },
                                       Secret.SearchFlags.ALL,
                                       null);
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


function makeLabel({issuer, name})
{
    return `${issuer}:${name}`;
}


async function get(args)
{
    let secret = await Secret.password_lookup(SCHEMA, makeAttributes(args), null);
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


async function update(old_arg, new_arg)
{
    let service = await Secret.Service.get(
        Secret.ServiceFlags.OPEN_SESSION | Secret.ServiceFlags.LOAD_COLLECTIONS,
        null);
    let old_attributes = makeAttributes(old_arg);
    let [item] = await service.search(SCHEMA,
                                      old_attributes,
                                      Secret.SearchFlags.UNLOCK
                                      | Secret.SearchFlags.LOAD_SECRETS,
                                      null);
    if (!item)
        throw new Error(_('Failed to lookup secret.'));

    // check if label changed
    let old_label = item.get_label();
    let new_label = makeLabel(new_arg);
    if (old_label != new_label)
        if (!await item.set_label(new_label, null))
            throw new Error(_('Failed to set label.'));

    // check if attributes changed
    let new_attributes = makeAttributes(new_arg);

    if (!equalDictionaries(old_attributes, new_attributes))
        if (!await item.set_attributes(SCHEMA, new_attributes, null))
            throw new Error(_('Failed to set attributes.'));

    // check if secret changed
    if (old_arg.secret != new_arg.secret) {
        let secret_value = new Secret.Value(new_arg.secret, -1, "text/plain");
        if (!await item.set_secret(secret_value, null))
            throw new Error(_('Failed to set secret.'));
    }
}


async function create(args)
{
    await ensureCollection();
    return await Secret.password_store(SCHEMA,
                                       makeAttributes(args),
                                       OTP_COLLECTION,
                                       makeLabel(args),
                                       args.secret,
                                       null);
}


function createSync(args)
{
    ensureCollectionSync();
    return Secret.password_store_sync(SCHEMA,
                                      makeAttributes(args),
                                      OTP_COLLECTION,
                                      makeLabel(args),
                                      args.secret,
                                      null);
}


async function remove(args)
{
    return await Secret.password_clear(SCHEMA,
                                       makeAttributes(args),
                                       null);
}
