/*  hotp.js
 * Copyright (C) 2025  Daniel K. O.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const GLib = imports.gi.GLib;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const OTP = Me.imports.otp;


// strings will be translated by gettext in the frontend
const _ = x => x;


var HOTP =
class HOTP extends OTP.OTP {

    constructor({
        issuer = '',
        name = '',
        secret = '',
        digits = 6,
        counter = 0,
        algorithm = 'SHA-1',
        uri = null
    } = {})
    {
        super();

        this.type = 'HOTP';

        if (uri) {
            let {
                host = null,
                issuer = '',
                secret = '',
                digits = 6,
                counter = 0,
                algorithm = 'SHA-1'
            } = OTP.parseURI(uri);
            if (host.toLowerCase() != 'hotp')
                throw new Error(_('URI host should be "hotp"'));
            this.issuer    = issuer;
            this.name      = name;
            this.secret    = secret;
            this.digits    = parseInt(digits);
            this.counter   = parseInt(counter);
            this.set_algorithm(algorithm);
        } else {
            this.issuer    = issuer;
            this.name      = name;
            this.secret    = secret;
            this.digits    = parseInt(digits);
            this.counter   = parseInt(counter);
            this.set_algorithm(algorithm);
        }
    }


    code(counter = this.counter)
    {
        return super.code(this.counter);
    }


    uri()
    {
        let args = {};
        if (this.counter != 0)
            args.counter = this.counter;
        return super.uri(args);
    }


    fields_non_destructive()
    {
        let result = super.fields_non_destructive();
        result.counter = this.counter.toString();
        return result;
    }

}; // class HOTP
