/*  base32.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


// strings will be translated by gettext in the frontend
const _ = x => x;


const digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';


// See RFC 4648
export
function decode(input, strict = true)
{
    console.assert(digits.length == 32);
    let output = [];

    // process 40 bits at a time (8 base32 digits)
    for (let i = 0; i < input.length; i += 8) {
        let chunk = input.substring(i, i + 8);

        if (chunk.length != 8) {
            if (strict)
                throw new Error(_('Invalid base32 input; missing padding.'));
            else
                chunk = chunk.padEnd(8, '=');
        }

        let value = 0;
        let pad = 0;
        for (let j = 0; j < 8; ++j) {
            let d = chunk[j].toUpperCase();
            let idx = digits.indexOf(d);

            if (d == '=') {
                idx = 0;
                ++pad;
            }
            if (idx == -1)
                throw new Error(_('Invalid base32 character at position:')
                                + ` ${i + j}`);

            value = value * 32 + idx;
        }

        if (pad == 2 || pad == 5 || pad == 7)
            throw new Error(_('Invalid padding.'));

        // store value as little endian
        let value_bytes = [];
        for (let j = 0; j < 5; ++j) {
            value_bytes.push(value % 256);
            value = Math.floor(value / 256);
        }
        // pad tells how many bytes to discard
        value_bytes = value_bytes.slice(Math.ceil(pad * 5 / 8));

        // turn to big endian
        value_bytes.reverse();
        output = output.concat(value_bytes);
    }

    return new Uint8Array(output);
}


export
function encode(input, trim = false)
{
    let output = '';

    for (let i = 0; i < input.length; i += 5) {
        // quantum is always padded with zeros
        let quantum = Array.from(input.slice(i, i + 5));
        let pad = 5 - quantum.length;
        for (let j = 0; j < pad; ++j)
            quantum.push(0);

        let value = 0;
        quantum.forEach(x => value = (value * 256) + parseInt(x));
        // note: qo is little endian
        let qo = [];
        for (let j = 0; j < 8; ++j) {
            let idx = value & 0x1f;
            qo.push(digits[idx]);
            value /= 32;
        }

        if (!trim) {
            let num_fill = Math.floor(pad * 8 / 5);
            qo.fill('=', 0, num_fill);
        }
        // reverse qo to big endian before joining the string
        output += qo.reverse().join('');
    }

    return output;
}



// Unit test
/*
function _test()
{
    function utf8(s)
    {
        let te = new TextEncoder();
        return te.encode(s);
    }

    function str(a)
    {
        let td = new TextDecoder();
        return td.decode(a);
    }

    function are_equal(a, b)
    {
        if (a.length != b.length)
            return false;
        for (let i = 0; i < a.length; ++i)
            if (a[i] != b[i])
                return false;
        return true;
    }

    function check(input, expected)
    {
        let tinput = utf8(input);
        let output = encode(tinput);
        console.assert(output === expected,
                       `BASE32("${input}") should be "${expected}" but got "${output}"`);
        let routput = decode(output);
        console.assert(are_equal(routput, tinput),
                       `deBASE32("${output}") should be "${input}"`);
        if (!are_equal(routput, tinput)) {
            console.error(routput);
            console.error(tinput);
        }
    }

    // Examples taken from RFC 4648
    check('', '');
    check('f', 'MY======');
    check('fo', 'MZXQ====');
    check('foo', 'MZXW6===');
    check('foob', 'MZXW6YQ=');
    check('fooba', 'MZXW6YTB');
    check('foobar', 'MZXW6YTBOI======');
}
*/

// _test();
