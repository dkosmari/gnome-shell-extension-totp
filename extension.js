/* extension.js
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */


// Shell misc imports
const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Indicator = Me.imports.indicator;


class Extension {

    constructor(uuid)
    {
        this.uuid = uuid;
    }

    enable()
    {
        this.indicator = new Indicator.Indicator(this.uuid);
    }

    disable()
    {
        this.indicator.destroy();
        this.indicator = null;
    }

}


function init(meta)
{
    ExtensionUtils.initTranslations(meta.uuid);
    return new Extension(meta.uuid);
}
