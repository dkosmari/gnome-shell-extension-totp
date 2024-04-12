/* myEntryRow.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


// Implements most of Adw.EntryRow the extension needs.


import Adw     from 'gi://Adw';
import Gio     from 'gi://Gio';
import GLib    from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk     from 'gi://Gtk';


function findByBuildableID(start, id)
{
    // Note: use BFS
    const queue = [start];
    while (queue.length > 0) {
        const current = queue.shift();
        if (current.get_buildable_id() == id)
            return current;

        let child = current.get_first_child();
        while (child) {
            queue.push(child);
            child = child.get_next_sibling();
        }
    }
    return null;
}


export default
class EntryRow extends Adw.ActionRow {

    static {
        GObject.registerClass(
            {
                Properties: {
                    'text': GObject.ParamSpec.string(
                        'text',
                        'Text',
                        'The text content',
                        GObject.ParamFlags.READWRITE,
                        ''
                    )
                }
            },
            this);
    }


    constructor({text = "", ...args})
    {
        args.title_lines = 1;
        args.subtitle_lines = 1;
        super(args);

        const title_box = findByBuildableID(this, 'title_box');
        if (title_box) {
            title_box.halign = Gtk.Align.START;
            title_box.hexpand = false;
        }

        const entry = new Gtk.Entry({
            text: text,
            halign: Gtk.Align.FILL,
            hexpand: true,
        });

        // this.#entry.add_css_class('flat');
        this.bind_property('text',
                           entry, 'text',
                           GObject.BindingFlags.BIDIRECTIONAL);

        this.add_suffix(entry);

    }

};
