/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Indicator = Me.imports.indicator.Indicator;


class Extension {

    constructor(meta)
    {
        this._meta = meta;
    }

    enable()
    {
        this._indicator = new Indicator(this);
    }

    disable()
    {
        this._indicator?.destroy();
        this._indicator = null;
    }

    get uuid()
    {
        return this._meta.uuid;
    }

};


function init(meta)
{
    ExtensionUtils.initTranslations();
    return new Extension(meta);
}
