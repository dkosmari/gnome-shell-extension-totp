/* mySpinRow.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


// Implements most of Adw.SpinRow the extension needs.


const Adw     = imports.gi.Adw;
const Gio     = imports.gi.Gio;
const GLib    = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk     = imports.gi.Gtk;


var SpinRow =
class SpinRow extends Adw.ActionRow {

    static {
        GObject.registerClass(
            {
                Properties: {
                    'value': GObject.ParamSpec.double(
                        'value',
                        'Value',
                        'The value',
                        GObject.ParamFlags.READWRITE,
                        -Number.MAX_VALUE,
                        Number.MAX_VALUE,
                        0
                    )
                }
            },
            this);
    }


    constructor({adjustment = null,
                 climb_rate = null,
                 digits = null,
                 numeric = null,
                 snap_to_ticks = null,
                 update_policy = null,
                 wrap = null,
                 value = null,
                 ...args})
    {
        super(args);

        const spin = new Gtk.SpinButton({
            adjustment,
            climb_rate,
            digits,
            numeric,
            snap_to_ticks,
            update_policy,
            wrap,
            value,
        });

        this.bind_property('value',
                           spin.adjustment, 'value',
                           GObject.BindingFlags.BIDIRECTIONAL);

        this.add_suffix(spin);
    }


};
