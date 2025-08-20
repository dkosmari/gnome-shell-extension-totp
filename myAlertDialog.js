/* myAlertDialog.js
 * Copyright (C) 2025  Daniel K. O.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Implements most of Gtk.AlertDialog the extension needs.


const Gio     = imports.gi.Gio;
const GLib    = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk     = imports.gi.Gtk;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const _ = ExtensionUtils.gettext;


const DialogError = {
    CANCELLED: 1,
    DISMISSED: 2,
};


const DIALOG_ERROR_QUARK = 'my-dialog-error-quark';


var AlertDialog =
class AlertDialog extends Gtk.MessageDialog {

    static {
        GObject.registerClass(this);
    }


    #cancel_return = -1;
    #cancellable_signal = 0;
    #task;


    constructor({message,
                 detail,
                 default_button = null,
                 cancel_button = null,
                 buttons = [],
                 ...args})
    {
        args.text = message;
        args.secondary_text = detail;
        super(args);

        if  (buttons?.length > 0) {
            buttons.forEach((label, i) => {
                this.add_button(label, i);
                if (default_button === i)
                    this.set_default_response(i);
                if (cancel_button === i)
                    this.#cancel_return = i;
            });
        } else {
            this.add_button(_('_Close'), 0);
            this.set_default_response(0);
            this.#cancel_return = 0;
        }
    }


    choose(parent, cancellable, callback)
    {
        this.#task = Gio.Task.new(this, cancellable, callback);
        if (cancellable)
            this.#cancellable_signal = cancellable.connect('cancelled',
                                                           c => this._cancelled_cb(c));

        this.transient_for = parent;
        this.present();
    }


    show(parent)
    {
        this.choose(parent, null, null);
    }


    choose_finish(result)
    {
        return result.propagate_int();
    }


    _cancelled_cb(cancellable)
    {
        this.on_response(Gtk.ResponseType.CLOSE);
    }


    on_response(response)
    {
        const cancellable = this.#task.get_cancellable();
        if (cancellable) {
            cancellable.disconnect(this.#cancellable_signal);
            this.#cancellable_signal = 0;
        }

        if (response == Gtk.ResponseType.CLOSE) {
            this.#task.return_error(
                new GLib.Error(GLib.quark_from_string(DIALOG_ERROR_QUARK),
                               DialogError.CANCELLED,
                               "Cancelled by application")
            );
        } else if (response >= 0) {
            // clicked on a button
            this.#task.return_int(response);
        } else {
            if (this.#cancel_return >= 0) {
                // dialog was closed -> interpret as a cancel response
                this.#task.return_int(this.#cancel_return);
            } else {
                // no cancel response on close, so generate an error
                this.#task.return_error(
                    new GLib.Error(GLib.quark_from_string(DIALOG_ERROR_QUARK),
                                   DialogError.DISMISSED,
                                   "Dismissed by user")
                );
            }
        }

        this.destroy();
    }
};
