/*  totp.js
 * Copyright (C) 2025  Daniel K. O.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// See RFC 6238

const GLib = imports.gi.GLib;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const OTP = Me.imports.otp;


// strings will be translated by gettext in the frontend
const _ = x => x;


function now()
{
    return new Date().getTime() / 1000;
}


var TOTP =
class TOTP extends OTP {

    constructor({
        issuer = '',
        name = '',
        secret = '',
        digits = 6,
        period = 30,
        algorithm = 'SHA-1',
        uri = null
    } = {})
    {
        super();

        this.type = 'TOTP';

        if (uri) {
            let {
                host = null,
                issuer = '',
                name = '',
                secret = '',
                digits = 6,
                period = 30,
                algorithm = 'SHA-1'
            } = OTP.parseURI(uri);
            if (host.toLowerCase() != "totp")
                throw new Error(_('URI host should be "totp"'));
            this.issuer = issuer;
            this.name   = name;
            this.secret = secret;
            this.digits = parseInt(digits);
            this.period = parseInt(period);
            this.set_algorithm(algorithm);
        } else {
            this.issuer = issuer;
            this.name   = name;
            this.secret = secret;
            this.digits = parseInt(digits);
            this.period = parseInt(period);
            this.set_algorithm(algorithm);
        }
    }


    code(time = now())
    {
        const counter = Math.trunc(time / this.period);
        return super.code(counter);
    }


    // return code and expiry
    code_and_expiry()
    {
        const t = now();
        const code = this.code(t);
        const expiry = (Math.trunc(t / this.period) + 1) * this.period;
        return [code, expiry];
    }


    uri()
    {
        let args = {};
        if (this.period != 30)
            args.period = this.period;
        return super.uri(args);
    }


    // return all members as strings, as required by libsecret
    fields_non_destructive()
    {
        let result = super.fields_non_destructive();
        result.period = this.period.toString();
        return result;
    }

}; // class TOTP
