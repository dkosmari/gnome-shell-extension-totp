/*  pins.js
 * Copyright (C) 2025  Daniel K. O.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Asks the user for the PIN of a Yandex OTP entry.
 *
 * The old Yandex scheme derives the key from the PIN, and Yandex never exports
 * it, so an entry imported from a file cannot produce a code until the PIN is
 * typed in. The question therefore belongs in the import flow, not in a later
 * "edit the entry and set the PIN" chore.
 */

import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';


// strings will be translated by gettext in the frontend
const _ = x => x;


export
class PinDialog extends Gtk.Dialog {

    static {
        GObject.registerClass(this);
    }


    #entry;
    #resolve = null;


    constructor({title, detail, pin_length = 0})
    {
        super({
            title: title || _('Yandex PIN'),
            default_width: 420,
            use_header_bar: true
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12
        });
        this.set_child(box);

        box.append(new Gtk.Label({
            label: detail || '',
            xalign: 0,
            wrap: true
        }));

        this.#entry = new Gtk.Entry({
            placeholder_text: pin_length
                ? _('PIN') + ` (${pin_length})`
                : _('PIN'),
            input_purpose: Gtk.InputPurpose.DIGITS,
            visibility: false,
            activates_default: true
        });
        box.append(this.#entry);

        this.add_button(_('_Skip'), Gtk.ResponseType.CANCEL);
        const ok_button = this.add_button(_('_OK'), Gtk.ResponseType.OK);
        ok_button.add_css_class('suggested-action');
        this.set_default_widget(ok_button);

        this.connect('response', (dlg, response) => this.#finish(response));
    }


    // Used by tests, and by callers that want to prefill the field.
    set_text(text)
    {
        this.#entry.text = text;
    }


    #finish(response)
    {
        const text = this.#entry.text.trim();
        const resolve = this.#resolve;
        this.#resolve = null;
        this.close();
        if (resolve)
            resolve(response == Gtk.ResponseType.OK ? text : null);
    }


    choose(parent)
    {
        this.transient_for = parent;
        this.modal = !!parent;
        this.visible = true;

        return new Promise(resolve => {
            this.#resolve = resolve;
        });
    }

};


/*
 * Ask for the PIN until it is valid, or until the user skips the entry.
 * Returns the PIN, or null.
 *
 * `make_dialog` exists so that the retry logic can be tested without GTK.
 */
export
async function ask_pin(parent, otp, make_dialog = (args) => new PinDialog(args))
{
    const detail = _('The code for') + ` "${otp.issuer}: ${otp.name}" `
                 + _('is computed from a PIN that Yandex does not export.');
    let error = '';

    for (;;) {
        const dialog = make_dialog({
            title: _('Yandex PIN'),
            detail: error ? detail + '\n\n' + error : detail,
            pin_length: otp.pin_length
        });

        const pin = await dialog.choose(parent);
        if (pin === null || pin === '')
            return null;

        otp.pin = pin;
        try {
            otp.check_pin();
            return pin;
        }
        catch (e) {
            // Ask again with the reason, instead of importing an entry that would
            // never produce a correct code.
            error = e.message;
            otp.pin = '';
        }
    }
}
