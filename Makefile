JQ := jq

ifeq (, $(shell which $(JQ)))
$(error "$(JQ)" executable not found)
endif


GETTEXT_DOMAIN := $(shell $(JQ) -r '.["gettext-domain"]' metadata.json)
PACKAGE := $(shell $(JQ) -r ".name" metadata.json)
SETTINGS_SCHEMA := $(shell $(JQ) -r '.["settings-schema"]' metadata.json)
URL	:= $(shell $(JQ) -r '.url' metadata.json)
UUID	:= $(shell $(JQ) -r ".uuid" metadata.json)


ZIP_FILE := $(UUID).shell-extension.zip

POT_FILE := po/$(GETTEXT_DOMAIN).pot
PO_FILES := $(wildcard po/*.po)

SOURCES := extension.js prefs.js
EXTRA_SOURCES := $(wildcard src/*.js)

GRESOURCE_XML := icons.gresource.xml
GRESOURCE_FILE := $(GRESOURCE_XML:.xml=)
GSCHEMA_XML_FILE := schemas/$(SETTINGS_SCHEMA).gschema.xml

EXTRA_DIST := \
	$(GRESOURCE_FILE) \
	AUTHORS \
	COPYING \
	prefs.css \
	README.md


.PHONY: all clean install update-po


all: $(ZIP_FILE)


clean:
	$(RM) $(ZIP_FILE)
	$(RM) $(GRESOURCE_FILE)
	$(RM) po/*.mo
	$(RM) schemas/gschema.compiled


install: $(ZIP_FILE)
	gnome-extensions install --force $(ZIP_FILE)


$(ZIP_FILE):	$(EXTRA_DIST) \
		$(EXTRA_SOURCES) \
		$(GSCHEMA_XML_FILE) \
		$(PO_FILES) \
		$(SOURCES)
	gnome-extensions pack \
		--force \
		--extra-source=src \
		$(patsubst %,--extra-source=%,$(EXTRA_DIST))


%.gresource:	%.gresource.xml \
		$(shell glib-compile-resources --generate-dependencies $(GRESOURCE_XML))
	glib-compile-resources $< --target=$@


$(POT_FILE): $(SOURCES) $(EXTRA_SOURCES)
	xgettext --from-code=UTF-8 --output=$@ $^


update-po: $(PO_FILES)


%.po: $(POT_FILE)
	msgmerge --update $@ $^
	touch $@

