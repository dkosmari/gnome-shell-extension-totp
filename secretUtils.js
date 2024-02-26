/*  secretUtils.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const {Gio, GLib, Secret} = imports.gi;


Gio._promisify(Secret, 'password_clear', 'password_clear_finish');
Gio._promisify(Secret, 'password_lookup', 'password_lookup_finish');
Gio._promisify(Secret, 'password_search', 'password_search_finish');
Gio._promisify(Secret, 'password_store', 'password_store_finish');
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
    try {
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
    catch (e) {
        logError(e, 'ensureCollection()');
        throw e;
    }
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
        logerror(e, 'getList()');
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
    try {
        let secret = await Secret.password_lookup(SCHEMA, makeAttributes(args), null);
        if (!secret)
            throw new Error(`failed to retrieve secret for ${args.name}`);
        return secret;
    }
    catch (e) {
        logError(e, 'get()');
        throw e;
    }
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
    try {
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
            throw new Error(`failed to lookup item for ${old_arg.name}`);

        // check if label changed
        let old_label = item.get_label();
        let new_label = makeLabel(new_arg);
        if (old_label != new_label)
            if (!await item.set_label(new_label, null))
                throw new Error(`failed to set item label from ${old_label} to ${new_label}`);

        // check if attributes changed
        let new_attributes = makeAttributes(new_arg);

        if (!equalDictionaries(old_attributes, new_attributes))
            if (!await item.set_attributes(SCHEMA, new_attributes, null))
                throw new Error(`failed to set item attributes for ${new_label}`);

        // check if secret changed
        if (old_arg.secret != new_arg.secret) {
            let secret_value = new Secret.Value(new_arg.secret, -1, "text/plain");
            if (!await item.set_secret(secret_value, null))
                throw new Error(`failed to set item secret for ${new_label}`);
        }
    }
    catch (e) {
        logError(e, 'update()');
        throw e;
    }
}


async function create(args)
{
    try {
        await ensureCollection();
        return await Secret.password_store(SCHEMA,
                                           makeAttributes(args),
                                           OTP_COLLECTION,
                                           makeLabel(args),
                                           args.secret,
                                           null);
    }
    catch (e) {
        logError(e, 'create()');
        return false;
    }
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
    try {
        return await Secret.password_clear(SCHEMA,
                                           makeAttributes(args),
                                           null);
    }
    catch (e) {
        logError(e, 'remove()');
        return false;
    }
}


function _test()
{
    createSync({
        issuer: 'NOBODY',
        name: 'ABC',
        secret: 'abcdabcd',
        digits: 6,
        period: 30,
        algorithm: 'SHA-1'
    });

    let s = getTOTPListSync();
    s.forEach(item => {
        item.load_secret_sync(null);
        let secret = item.get_secret().get_text();
        console.log(`    ${item.get_object_path()} : ${item.label} = ${secret}`);
    });

    console.log('retrieval test:');
    let a = getSync('ABC');
    console.log(a);
}

//_test();
