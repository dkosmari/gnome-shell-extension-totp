/* indicator.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


// GI imports
const { Gio, GLib, GObject, St, Secret } = imports.gi;


// Shell UI imports
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;


// Shell misc imports
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const TOTP = Me.imports.totp;
const SecretUtils = Me.imports.secretUtils;

// gettext support
const _ = ExtensionUtils.gettext;


function copyToClipboard(text)
{
    // this runs inside gnome-shell, so we use St
    let clipboard = St.Clipboard.get_default();
    clipboard.set_text(St.ClipboardType.PRIMARY, text);
    clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
    Main.notify(_('OTP code copied.'), text);
}


function makeLabel({issuer, name})
{
    return `${issuer} / ${name}`;
}


var Indicator = class extends PanelMenu.Button {

    static {
        GObject.registerClass(this);
    }


    constructor(uuid)
    {
        super();
        this._uuid = uuid;
        this._totp_items = [];
    }


    _init()
    {
        super._init(0.5, 'TOTP');

        let icon = new St.Icon(
                {
                    icon_name: 'dialog-password',
                    style_class: 'system-status-icon'
                }
        );
        this.add_child(icon);

        this.menu.addAction(_('Edit secrets...'),
                            this.editSecrets.bind(this),
                           'document-edit-symbolic');


        Main.panel.addToStatusArea(this._uuid, this);
    }


    _onOpenStateChanged(menu, is_open)
    {
        super._onOpenStateChanged(menu, is_open);

        if (is_open)
            this.addItems();
        else
            this.clearItems();
    }


    editSecrets()
    {
        ExtensionUtils.openPrefs();
    }


    async addItems()
    {
        try {
            let secrets = await SecretUtils.getList();
            secrets.forEach(x => {
                let attributes = x.get_attributes();
                let label = `${attributes.issuer} / ${attributes.name}`;
                this.addItem(label, attributes);
            });
        }
        catch (e) {
            logError(e, 'addSecretItems()');
            Main.notifyError(_('Cannot lookup OTP items'), e.message);
        }
    }


    addItem(label, attributes)
    {
        let item = this.menu.addAction(label,
                                       this.copyCode.bind(this, attributes),
                                       'edit-copy-symbolic');

        this._totp_items.push(item);
    }


    clearItems()
    {
        this._totp_items.forEach(x => x.destroy());
        this._totp_items = [];
    }


    async copyCode(args)
    {
        try {
            console.log(`copying TOTP secret for ${args.name}`);
            args.secret = await SecretUtils.get(args);
            let totp = new TOTP.TOTP(args);
            let code = totp.code();
            console.log(`CODE: ${code}`);
            copyToClipboard(code);
        }
        catch (e) {
            logError(e, 'copyCode()');
            Main.notifyError(_('Failed to copy OTP code'), e.message);
        }
    }

};
