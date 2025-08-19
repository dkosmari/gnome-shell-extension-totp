/* mySwitchRow.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


// Implements most of Adw.SwitchRow the extension needs.

const Adw     = imports.gi.Adw;
const Gio     = imports.gi.Gio;
const GLib    = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk     = imports.gi.Gtk;


var SwitchRow =
class SwitchRow extends Adw.ActionRow {

    static {
        GObject.registerClass(
            {
                Properties: {
                    'value': GObject.ParamSpec.boolean(
                        'active',
                        'Active',
                        'The active state',
                        GObject.ParamFlags.READWRITE,
                        0
                    )
                }
            },
            this);
    }


    constructor({active = null,
                 ...args})
    {
        super(args);

        const sw = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
            active
        });
        sw.add_css_class('flat');

        this.bind_property('active',
                           sw, 'active',
                           GObject.BindingFlags.BIDIRECTIONAL);

        this.add_suffix(sw);
    }


};
