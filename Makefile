JQ := jq

ifeq (, $(shell which $(JQ)))
$(error "$(JQ)" executable not found)
endif


UUID := $(shell $(JQ) -r ".uuid" metadata.json)
GETTEXT_DOMAIN := $(shell $(JQ) -r '.["gettext-domain"]' metadata.json)


ZIP_FILE := $(UUID).shell-extension.zip

POT_FILE := po/$(GETTEXT_DOMAIN).pot
PO_FILES := $(wildcard po/*.po)

SOURCES := extension.js prefs.js
EXTRA_SOURCES := $(wildcard src/*.js)

GRESOURCE_XML := icons.gresource.xml
GRESOURCE_FILE := $(GRESOURCE_XML:.xml=)
EXTRA_DIST := \
	AUTHORS \
	COPYING \
	README.md \
	$(GRESOURCE_FILE)


.PHONY: all clean install update-po


all: $(ZIP_FILE)


clean:
	$(RM) $(ZIP_FILE)
	$(RM) $(GRESOURCE_FILE)
	$(RM) po/*.mo


install: $(ZIP_FILE)
	gnome-extensions install --force $(ZIP_FILE)


$(ZIP_FILE): $(SOURCES) $(EXTRA_SOURCES) $(EXTRA_DIST) $(PO_FILES)
	gnome-extensions pack \
		--force \
		--podir=po \
		--extra-source=src \
		$(patsubst %,--extra-source=%,$(EXTRA_DIST))


%.gresource: %.gresource.xml $(shell glib-compile-resources --generate-dependencies $(GRESOURCE_XML))
	glib-compile-resources $< --target=$@


$(POT_FILE): $(SOURCES) $(EXTRA_SOURCES)
	xgettext --from-code=UTF-8 --output=$@ $^


update-po: $(PO_FILES)


%.po: $(POT_FILE)
	msgmerge --update $@ $^
	touch $@

