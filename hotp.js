/*  hotp.js
 * Copyright (C) 2025  Daniel K. O.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * See RFC 4226
 *
 * Test case, from Appendix D:
 * secret = "12345678901234567890"
 *        = base64("MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=")
 *        = base32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
 * everything else is default:
 *  digits = 6
 *  counter = 0
 *  algorithm = SHA-1
 *
 * URI: otpauth://hotp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=RFC%204226
 *
 * Expected output:
 *
 *   counter   code
 *   ---------------
 *      0     755224
 *      1     287082
 *      2     359152
 *      3     969429
 *      4     338314
 *      5     254676
 *      6     287922
 *      7     162583
 *      8     399871
 *      9     520489
 */

import * as OTP from './otp.js';


// strings will be translated by gettext in the frontend
const _ = x => x;


export default
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
                name = '',
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
            this.algorithm = OTP.normalized_algorithm(algorithm);
        } else {
            this.issuer    = issuer;
            this.name      = name;
            this.secret    = secret;
            this.digits    = parseInt(digits);
            this.counter   = parseInt(counter);
            this.algorithm = OTP.normalized_algorithm(algorithm);
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
