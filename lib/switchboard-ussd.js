// Possible configuration items:
//
// * translation.<lang>:
//     Jed translation JSON for language (e.g. sw). Optional. If ommitted,
//     untranslated strings are used.
//
// * config:
//     * qa:
//         Set to true to turn on QA features. Default is false.
//     * default_lang:
//         Default language. Default is 'en'.
//     * swb_api:
//         Dictionary of username, password and url of the Switchboard API.
//         If ommitted, the dummy API is used instead.
//     * sms_tag:
//         Two element list of [pool, tag] giving the Go endpoint to send SMSes
//         out via. If ommitted, SMSes are not sent.
//     * metric_store:
//         Name of the metric store to use. If omitted, metrics are sent
//         to the metric store named 'default'.
//     * valid_user_addresses:
//         JSON list of allowed from_addr regular expression patterns.
//         Optional. If omitted, all from_addr values are allowed.
//
// It is suspected that the Vodacom Tz prefixes are: 255743 - 6, 25575 and
// 25576.
//
// Metrics produced:
//
// * ussd_sessions
// * unique_users
// * first_session_completed
// * second_session_completed
// * sessions_taken_to_register (average)
// * session_new_in.<state-name>
// * session_closed_in.<state-name>
// * possible_timeout_in.<state-name>
// * state_entered.<state-name>
// * state_exited.<state-name>

var vumigo = require("vumigo_v01");
var jed = require("jed");

if (typeof api === "undefined") {
    // testing hook (supplies api when it is not passed in by the real sandbox)
    var api = this.api = new vumigo.dummy_api.DummyApi();
}

var Promise = vumigo.promise.Promise;
var success = vumigo.promise.success;
var maybe_promise = vumigo.promise.maybe_promise;
var State = vumigo.states.State;
var Choice = vumigo.states.Choice;
var ChoiceState = vumigo.states.ChoiceState;
var LanguageChoice = vumigo.states.LanguageChoice;
var PaginatedChoiceState = vumigo.states.PaginatedChoiceState;
var FreeText = vumigo.states.FreeText;
var EndState = vumigo.states.EndState;
var InteractionMachine = vumigo.state_machine.InteractionMachine;
var StateCreator = vumigo.state_machine.StateCreator;


function DummySwitchboardApi(im) {

    var self = this;

    self.im = im;

    self.list_cadres = function() {
        var p = new Promise();
        p.callback([
            // Medical Specialist, AMO and Dental Specialist
            // use numerical IDs to match default IDs for cadres
            // with specialties.
            {id: 1, text: "Medical Specialist"},
            {id: "mo", text: "MO"}, // Medical Officer
            {id: 60, text: "AMO"}, // Assistant Medical Officer
            {id: "co", text: "CO"}, // Clinical Officer
            {id: "aco", text: "ACO"}, // Assistant Clinical Officer
            {id: 67, text: "Dental Specialist"},
            {id: "do", text: "Dental Officer"},
            {id: "ado", text: "ADO"}, // Assitant Dental Officer
            {id: "dt", text: "Dental Therapist"}
        ]);
        return p;
    };

    self.list_districts = function(query) {
        var p = new Promise();
        p.callback([
            {id: "kigoma-mc", text: "Kigoma MC"},
            {id: "kigoma-dc", text: "Kigoma DC"},
            {id: "kasulu-dc", text: "Kasulu DC"}
        ]);
        return p;
    };

    self.list_facility_types = function() {
        var p = new Promise();
        var _ = self.im.i18n;
        p.callback([
            {id: "hospital", text: _.gettext("Hospital")},
            {id: "health-centre", text: _.gettext("Health Centre")},
            {id: "dispensary", text: _.gettext("Dispensary")},
            {id: "clinic", text: _.gettext("Clinic")},
            {id: "mhsw", text: _.gettext("Ministry of Health and " +
                                         "Social Welfare")},
            {id: "council", text: _.gettext("Council")},
            {id: "training", text: _.gettext("Training Institution")},
            {id: "zonal-training", text: _.gettext("Zonal Training" +
                                                   " Centre")},
            {id: "ngo", text: _.gettext("NGO")}
        ]);
        return p;
    };

    self.list_facilities = function(district, facility_type, query) {
        var p = new Promise();
        p.callback([
            {id: "wazazi-galapo", text: "Wazazi Galapo"},
            {id: "wazazi-magugu", text: "Wazazi Magugu"},
            {id: "wazazu-mchuo", text: "Wazazu Mchuo"}
        ]);
        return p;
    };

    self.list_specialities = function(cadre_id) {
        var p = new Promise();
        var specialities = [];
        if (cadre_id == 67) {
            specialities = [
                {id: "cd", text: "Community Dentistry"},
                {id: "ms", text: "Maxilofacial Surgery"}
            ];
        }
        else if (cadre_id == 1) {
            specialities = [
                {id: "anaesthesia", text: "Anaesthesia"},
                {id: "anatomy", text: "Anatomy"}
            ];
        }
        else if (cadre_id == 60) {
            specialities = [
                {id: "anaesthesiology", text: "Anaesthesiology"},
                {id: "em", text: "Emergency Medicime"}
            ];
        }
        p.callback(specialities);
        return p;
    };

    self.submit_unknown_cadre = function(user_addr, cadre_name) {
        // Do nothing.
        return success();
    };

    self.submit_unknown_facility = function(user_addr, facility, region,
                                            facility_type) {
        // Do nothing.
        return success();
    };

    self.cadre_needs_specialties = function(cadre_id) {
        var cadres_with_specialties = [1, 67, 60];
        var needs_specialties = cadres_with_specialties.some(
            function (i) {
                return i == cadre_id;
            });
        return success(needs_specialties);
    };

    self.register_health_worker = function(health_worker) {
        return success();
    };
}


function SwitchboardApiError(msg) {
    var self = this;
    self.msg = msg;

    self.toString = function() {
        return "<SwitchboardApiError: " + self.msg + ">";
    };
}


function SwitchboardApi(im, url, username, password) {

    var self = this;

    self.im = im;
    self.lang = im.user.lang || im.config.default_lang || "en";
    self.url = url;
    self.headers = {
        'Content-Type': ['application/json']
    };

    if (username) {
        var hash = (new Buffer(username + ":" + password)).toString('base64');
        self.headers['Authorization'] = ['Basic ' + hash];
    }

    self.check_reply = function(reply, url, method, data, ignore_error) {
        var error;
        if (reply.success && reply.code == 200) {
            var json = JSON.parse(reply.body);
            if (json.status === 0) {
                return json;
            }
            error = ("API did not return status OK (got " +
                     json.status + " instead)");
        }
        else {
            error = reply.reason;
        }
        var error_msg = ("SwB API " + method + " to " + url + " failed: " +
                         error);
        if (typeof data != 'undefined') {
            error_msg = error_msg + '; data: ' + JSON.stringify(data);
        }
        self.im.log(error_msg);
        if (!ignore_error) {
            throw new SwitchboardApiError(error_msg);
        }
    };

    self.api_get = function(api_cmd, params) {
        var p = new Promise();
        var url = self.url + api_cmd;
        var items = [];
        for (var key in params) {
            items[items.length] = (encodeURIComponent(key) + '=' +
                                   encodeURIComponent(params[key]));
        }
        if (items.length !== 0) {
            url = url + '?' + items.join('&');
        }
        self.im.api.request("http.get", {
                url: url,
                headers: self.headers
            },
            function(reply) {
                var json = self.check_reply(reply, url, 'GET', false);
                p.callback(json);
            });
        return p;
    };

    self.api_post = function(api_cmd, data, ignore_error) {
        var p = new Promise();
        var url = self.url + api_cmd;
        self.im.api.request("http.post", {
                url: url,
                headers: self.headers,
                data: JSON.stringify(data)
            },
            function(reply) {
                var json = self.check_reply(reply, url, 'POST', data,
                                            ignore_error);
                p.callback(json);
            });
        return p;
    };

    // only allow printable ASCII x20 (space) to x73 (tilde)
    self.non_printable_ascii_re = /[^\x20-\x7E]/g;

    self.clean_title = function(title) {
        return title.replace(self.non_printable_ascii_re, '?');
    };

    self.list_cadres = function() {
        var p = self.api_get('specialties', {lang: self.lang});
        p.add_callback(function (result) {
            var cadres = result.specialties.filter(function (s) {
                return (s.parent_specialty_id === null);
            });
            return cadres.map(function (s) {
                var text = s.short_title ? s.short_title : s.title;
                text = self.clean_title(text);
                return {id: s.id, text: text};
            });
        });
        return p;
    };

    self.list_districts = function(query) {
        var p = self.api_get('regions', {
            type: 'District',
            title: query,
            lang: self.lang
        });
        p.add_callback(function (result) {
            return result.regions.map(function (r) {
                return {id: r.id, text: self.clean_title(r.title)};
            });
        });
        return p;
    };

    self.list_facility_types = function() {
        var p = self.api_get('facility-types', {lang: self.lang});
        p.add_callback(function (result) {
            return result.facility_types.map(function (f) {
                return {id: f.id, text: self.clean_title(f.title)};
            });
        });
        return p;
    };

    self.deduplicate_items = function(items, get_title, dedup) {
        var title_map = {};
        var title = null;
        var title_items;
        items.forEach(function (item) {
            title = get_title(item);
            if (!title_map[title]) {
                title_map[title] = [item];
                return;
            }
            title_items = title_map[title];
            if (title_items.length == 1) {
                dedup(title_items[0]);
            }
            dedup(item);
            title_items.push(item);
        });
    };

    self.list_facilities = function(district, facility_type, query) {
        var params = {
            title: query,
            lang: self.lang
        };
        if (district !== null) {
            params.region = district;
        }
        if (facility_type !== null) {
            params.type = facility_type;
        }
        var p = self.api_get('facilities', params);
        p.add_callback(function (result) {
            self.deduplicate_items(
                result.facilities,
                function(f) { return f.title },
                function(f) {
                    if (f.region && f.region.title)
                        f.title = f.title + " " + f.region.title;
                }
            );
            return result.facilities.map(function (f) {
                return {id: f.id, text: self.clean_title(f.title)};
            });
        });
        return p;
    };

    self.list_specialities = function(cadre_id) {
        cadre_id = Number(cadre_id);
        var p = self.api_get('specialties', {lang: self.lang});
        p.add_callback(function (result) {
            var specialties = result.specialties.filter(function (s) {
                return (s.parent_specialty_id === cadre_id);
            });
            return specialties.map(function (s) {
                var text = s.short_title ? s.short_title : s.title;
                text = self.clean_title(text);
                return {id: s.id, text: text};
            });
        });
        return p;
    };

    self.submit_unknown_cadre = function(user_addr, cadre_name) {
        var p = self.api_post('specialties', {
            msisdn: user_addr.slice(0, 32), // maximum size allowed by API
            title: cadre_name,
            parent_specialty: null,
            lang: self.lang
        }, true); // TODO: stop ignoring errors once API accepts duplicates
        p.add_callback(function (result) {
            return (typeof result == "undefined") ? null : result.id;
        });
        return p;
    };

    self.submit_unknown_facility = function(user_addr, facility, region,
                                            facility_type) {
        var p = self.api_post('facilities', {
            msisdn: user_addr.slice(0, 32), // maximum size allowed by API
            title: facility,
            region: region,
            type: facility_type,
            address: null,
            lang: self.lang
        }, true); // TODO: stop ignoring errors once API accepts duplicates
        p.add_callback(function (result) {
            return (typeof result == "undefined") ? null : result.id;
        });
        return p;
    };

    self.cadre_needs_specialties = function(cadre_id) {
        cadre_id = Number(cadre_id);
        var p = self.api_get('specialties', {lang: self.lang});
        p.add_callback(function (result) {
            var cadres = result.specialties.filter(function (s) {
                return (s.id === cadre_id);
            });
            if (cadres.length != 1) {
                return false;
            }
            var cadre = cadres[0];
            return cadre.is_query_subspecialties;
        });
        return p;
    };

    self.register_health_worker = function(health_worker) {
        var p = self.api_post('health-workers', {
            name: health_worker.full_name, // string (required)
            surname: health_worker.surname, // string (required)
            specialties: health_worker.specialties, // [SpecialtyID, ...]
            country: health_worker.country, // string
            facility: health_worker.facility, // FacilityID, primary facility
            vodacom_phone: health_worker.vodacom_phone, // string, MSISDN
            mct_registration_number: health_worker.registration_number, // str
            mct_payroll_number: health_worker.cheque_number, // string
            language: self.lang
        });
        return p;
    };
}


function RegisterHealthWorker() {
    var self = this;
    StateCreator.call(self, "intro");

    var _ = new jed({});
    self.options_per_page = 5;
    self.characters_per_page = 163;

    // SwB API creator

    self.swb_api = function(im) {
        var cfg = im.config.swb_api;
        if (!cfg) {
            im.log("Using dummy Switchboard API.");
            return new DummySwitchboardApi(im);
        }
        im.log("Using real Switchboard API.");
        return new SwitchboardApi(im, cfg.url, cfg.username, cfg.password);
    };

    self.qa = function(im) {
        if (im.config.qa) {
            return true;
        }
        return false;
    };

    // Session metrics helper

    self.incr_metric = function(im, metric) {
        var p = new Promise();
        p.add_callback(function (value) {
            im.metrics.fire_max(metric, value);
        });
        im.api.request(
            "kv.incr", {key: "metrics." + metric, amount: 1},
            function(reply) {
                if (reply.success) {
                    p.callback(reply.value);
                }
                else {
                    im.log("Failed to increment metric " + metric + ": " +
                           reply.reason);
                    p.callback(0);
                }
            });
        return p;
    }

    // SMSes

    self.send_sms = function(im, content) {
        var sms_tag = im.config.sms_tag;
        if (!sms_tag) return success(true);

        var p = new Promise();
        p.add_callback(function(success) {
          im.log('SMS sent: ' + success);
        });

        im.api.request("outbound.send_to_tag", {
            to_addr: im.user_addr,
            content: content,
            tagpool: sms_tag[0],
            tag: sms_tag[1]
        }, function(reply) {
            p.callback(reply.success);
        });
        return p;
    };

    self.send_sms_session1_abort = function(im) {
        var _ = im.i18n;
        var msg = _.gettext("If you would like to register at a later" +
                            " date please dial *149*24#.");
        return self.send_sms(im, msg);
    };

    self.send_sms_session1_end = function(im) {
        var _ = im.i18n;
        var msg = _.gettext("Thank you for beginning your registration" +
                            " process. Please dial *149*24# again to" +
                            " complete your registration in a few easy steps.");
        return self.send_sms(im, msg);
    };

    self.send_sms_session2_end = function(im) {
        var _ = im.i18n;
        var msg = _.gettext("Thank you for registering with The Health" +
                            " Network Programme. We will verify your" +
                            " registration within 2 weeks and confirm by SMS" +
                            " when you can make free calls.")
        return self.send_sms(im, msg);
    };

    self.send_sms_first_possible_timeout = function(im) {
        var _ = im.i18n;
        var msg = _.gettext("Your session has ended but you have not" +
                            " completed your registration. Please dial" +
                            " *149*24# again to continue with your" +
                            " registration where you left off.");
        return self.send_sms(im, msg);
    };

    // Vodacom number checker

    self.check_from_addr = function(im) {
        var patterns = im.config.valid_user_addresses;
        if (!patterns ||
            typeof patterns.length == 'undefined' ||
            patterns.length === 0) {
            return true;
        }
        var okay = patterns.some(function (p) {
            return Boolean(im.user_addr.match(p));
        });
        return okay;
    };

    // Session handling

    self.get_user_item = function(user, item, default_value) {
        var custom = user.custom || {};
        var value = custom[item];
        return (typeof value != 'undefined') ? value : default_value;
    };

    self.set_user_item = function(user, item, value) {
        if (typeof user.custom == 'undefined') {
            user.custom = {};
        }
        user.custom[item] = value;
    };

    self.inc_user_item = function(user, item) {
        var value = self.get_user_item(user, item, 0) + 1;
        self.set_user_item(user, item, value);
        return value;
    };

    // IM event callbacks

    self.on_session_new = function(event) {
        var p = self.incr_metric(event.im, 'ussd_sessions');
        p.add_callback(function () {
            return event.im.metrics.fire_inc('session_new_in.' +
                                             event.im.current_state.name);
        });
        p.add_callback(function () {
            return self.inc_user_item(event.im.user, 'ussd_sessions');
        });
        return p;
    };

    self.on_session_close = function(event) {
        var p = event.im.metrics.fire_inc('session_closed_in.' +
                                          event.im.current_state.name);
        if (event.data.possible_timeout) {
            p.add_callback(function () {
                return event.im.metrics.fire_inc('possible_timeout_in.' +
                                                 event.im.current_state.name);
            });
            var timeouts = self.inc_user_item(event.im.user,
                                              'possible_timeouts');
            if (timeouts <= 1) {
                p.add_callback(function () {
                    self.send_sms_first_possible_timeout(event.im);
                });
            }
        }
        return p;
    };

    self.on_new_user = function(event) {
        return self.incr_metric(event.im, 'unique_users');
    };

    self.on_state_enter = function(event) {
        return event.im.metrics.fire_inc('state_entered.' + event.data.state.name);
    };

    self.on_state_exit = function(event) {
        return event.im.metrics.fire_inc('state_exited.' + event.data.state.name);
    };

    // Create a healthworker based on user's answers
    self.create_health_worker = function (im) {
        var ans = im.get_user_answer;
        var swb_api = self.swb_api(im);
        var hw = {};

        hw.vodacom_phone = im.user_addr;
        hw.country = "TZ";
        hw.full_name = ans("first_name") + " " + ans("surname");
        hw.surname = ans("surname");
        hw.specialties = [ans("cadre")];

        var cheque_number = ans("cheque_number");
        if (cheque_number && !cheque_number.match('^[0Oo]$'))
            hw.cheque_number = cheque_number;
        
        var registration_number = ans("registration_number");
        if (registration_number && !registration_number.match('^[0Oo]$'))
            hw.registration_number = registration_number;

        var facility = ans("facility_select");
        if (facility)
          hw.facility = facility;

        var specialty = ans("select_speciality");
        if (specialty)
            hw.specialties[hw.specialties.length] = specialty;

        return hw;
    };

    // Session 1

        self.add_state(new LanguageChoice(
            "intro",
            function (choice) {
                if (self.check_from_addr(this.im)) {
                    return "cadre";
                }
                return "no_vodacom_sim";
            },
            _.gettext("Welcome to the Health Network. FREE calls brought to U by Switchboard, " +
                      "Ministry of Health, MAT and Vodacom." +
                      "\n" +
                      "Please choose a language"),
            [
                new Choice("sw", _.gettext("Swahili")),
                new Choice("en", _.gettext("English"))
            ],
            _.gettext("Please select a valid language.")
        ));
        self.add_state(new EndState(
            "no_vodacom_sim",
            _.gettext("Sorry. This service is only available to Health" +
                      " Practitioners with a Vodacom Sim card. Please" +
                      " register a new Vodacom SIM and then redial this" +
                      " number."),
            "intro"
        ));
        self.add_creator("cadre", function(state_name, im) {
            var _ = im.i18n;
            var swb_api = self.swb_api(im);
            var p = swb_api.list_cadres();
            p.add_callback(function (cadres) {
                var choices = cadres.map(function (c) {
                    return new Choice(c.id, c.text);
                });
                choices[choices.length] = new Choice("other",
                                                     _.gettext("Other"));
                return new PaginatedChoiceState(
                    state_name,
                    function (choice) {
                        return (choice.value == "other" ?
                                "cadre_other" :
                                "first_name");
                    },
                    _.gettext("What CADRE are you?"),
                    choices, null, {},
                    {
                        more: im.i18n.gettext("View more"),
                        back: im.i18n.gettext("Back"),
                        options_per_page: self.options_per_page,
                        characters_per_page: self.characters_per_page
                    }
                );
            });
            return p;
        });
        self.add_state(new FreeText(
            "cadre_other",
            function (content) {
                return (content == '0' ? "cadre" : "cadre_unavailable");
            },
            _.gettext("Please write the name of your CADRE or enter '0' to return to the list of CADRES:")
        ));
        self.add_state(new ChoiceState(
            "cadre_unavailable",
            function (choice, done) {
                if (choice.value == "back") {
                    done("cadre");
                }
                else if (choice.value == "yes") {
                    var im = this.im;
                    var swb_api = self.swb_api(im);
                    var cadre_name = im.get_user_answer("cadre_other");
                    var p = swb_api.submit_unknown_cadre(im.user_addr,
                                                         cadre_name);
                    p.add_callback(function (result) {
                        done("cadre_unavailable_contact");
                    });
                }
                else {
                    done("cadre_unavailable_dont_contact");
                }
            },

            _.gettext("Sorry, this service is not yet available for" +
                      " your CADRE. Would you like us to contact you when this" +
                      " service becomes available for you?"),
            [
                new Choice("yes", _.gettext("Yes")),
                new Choice("no", _.gettext("No")),
                new Choice("back", _.gettext("Back"))
            ]
        ));
        self.add_state(new EndState(
            "cadre_unavailable_contact",
            _.gettext("Thank you for trying to register, we will contact" +
                      " you when the programme is available for your cadre."),
            "intro"
        ));
        self.add_state(new EndState(
            "cadre_unavailable_dont_contact",
            _.gettext("Thank you for trying to register."),
            "intro"
        ));
        self.add_state(new EndState(
            "end", // to support old users who ended sessions in this state
            _.gettext("Thank you for trying to register."),
            "intro"
        ));
        self.add_state(new FreeText(
            "first_name",
            "surname",
            _.gettext("Please enter your first name.")
        ));
        self.add_state(new FreeText(
            "surname",
            "cheque_number",
            _.gettext("Please enter your surname.")
        ));
        self.add_state(new FreeText(
            "cheque_number",
            function (content) {
                return (content == '0' ? "registration_number" : "terms_and_conditions");
            },
            _.gettext("To verify U are a government worker enter last 7-9 digits of your cheque no " +
                      "(eg 1234567). Enter '0' if U do not have a cheque no or are not a government " +
                      "worker"),
            function (content) {
                return Boolean(content.match("^([0-9]{7,9}|[0Oo])$"));
            },
            _.gettext("Sorry but that is not a valid cheque number." +
                      " Please try again or enter '0' if you do not" +
                      " have a cheque number.")
        ));
        self.add_state(new FreeText(
            "registration_number",
            "terms_and_conditions",
            _.gettext("To verify U are a registered health worker enter your Medical Council of " +
                      "Tanganyika REGISTRATION # (eg 1234). Enter '0' if U do not have a Registration " +
                      "Number"),
            function (content) {
                return Boolean(content.match("^([0-9]{1,5}|[0Oo])$"));
            },
            _.gettext("Sorry but that is not a valid Registration Number." +
                      " Please try again or enter 0 if you do not have a" +
                      " registration number.")
        ));
        self.add_state(new ChoiceState(
            "dont_match_mct",
            function (choice) {
                return (choice.value == "again" ?
                        "cheque_number" :
                        "dont_match_mct_end");
            },
            _.gettext("Sorry but the registration number that you" +
                      " entered does not match with MCT records."),
            [
                new Choice("again", _.gettext("Enter details again")),
                new Choice("end", _.gettext("End Session"))
            ]
        ));
        self.add_state(new EndState(
            "dont_match_mct_end",
            _.gettext("Sorry but we cannot verify you at this point. " +
                      "Please verify your details with MCT and dial " +
                      "*149*24# again to register."),
            "intro"
        ));
        self.add_state(new ChoiceState(
            "terms_and_conditions",
            function (choice) {
                return (choice.value == "yes" ?
                        "session1_end" :
                        "session1_abort_yn");
            },
            _.gettext("Do you agree to the terms and conditions as laid" +
                      " out at http://www.healthnetwork.or.tz ?" +
                      " Your local DMO will also have a copy."),
            [
                new Choice("yes", _.gettext("Yes")),
                new Choice("no", _.gettext("No"))
            ]
        ));
        self.add_state(new ChoiceState(
            "session1_abort_yn",
            function (choice) {
                return (choice.value == "yes" ?
                        "session1_abort" :
                        "terms_and_conditions");
            },
            _.gettext("We are sorry but you cannot be registered unless" +
                      " you agree to the terms and conditions. Are you" +
                      " sure you would like to end the registration process?"),
            [
                new Choice("yes", _.gettext("Yes")),
                new Choice("no", _.gettext("No"))
            ]
        ));
        self.add_state(new EndState(
            "session1_abort",
            _.gettext("If you would like to register at a later date" +
                      " please dial *149*24#."),
            "intro",
            {
                on_enter: function () {
                    return self.send_sms_session1_abort(this.im);
                }
            }
        ));
        self.add_state(new EndState(
            "session1_end",
            _.gettext("Thank you. You have almost completed your " +
                      "registration process. Please dial *149*24# " +
                      "again to complete just a few more questions."),
            "session2_intro",
            {
                on_enter: function () {
                    var im = this.im;
                    var swb_api = self.swb_api(im);
                    var health_worker = self.create_health_worker(im);
                    var p = swb_api.register_health_worker(health_worker);
                    p.add_callback(function () {
                        return self.incr_metric(im, 'first_session_completed');
                    });
                    p.add_callback(function () {
                        return self.send_sms_session1_end(im);
                    });
                    p.add_callback(function () {
                        self.set_user_item(im.user, "registered", 1);
                        var sessions = self.get_user_item(im.user, 'ussd_sessions', 0);
                        return im.metrics.fire_avg('sessions_taken_to_register', sessions);
                    });
                    return p;
                }
            }
        ));

    // Session 2

        self.facility_or_district_select = function (content, done) {
            var swb_api = self.swb_api(this.im);
            var im = this.im;
            var p = swb_api.list_districts(content);
            p.add_callback(function (districts) {
                if (districts.length == 1) {
                    im.set_user_answer("district_select",
                                       districts[0].id);
                    done("facility_type");
                }
                else {
                    done("district_select");
                }
            });
        };

        self.add_state(new FreeText(
            "session2_intro",
            self.facility_or_district_select,
            _.gettext("Welcome back 2 the Health Network brought 2 U by " +
                      "Switchboard, Ministry of Health, MAT and Vodacom." +
                      "\n\n" +
                      "Please enter Ur district (eg Kilosa). No" +
                      " abbreviations please."),
            null, null, {
                on_enter: function () {
                    // clear district_reenter value on state enter
                    // in case a user gets to re-use the menu
                    this.im.set_user_answer("district_reenter", null);
                }
            }
        ));
        self.add_creator("district_select", function(state_name, im) {
            var _ = im.i18n;
            var swb_api = self.swb_api(im);
            var first_query = im.get_user_answer("session2_intro");
            var second_query = im.get_user_answer("district_reenter");
            var query = second_query || first_query;
            var p = swb_api.list_districts(query);
            p.add_callback(function (districts) {
                var choices = districts.map(function (d) {
                    return new Choice(d.id, d.text);
                });
                choices[choices.length] = new Choice(
                    null, _.gettext("None of the above"));

                return new PaginatedChoiceState(
                    state_name,
                    function (choice) {
                        if (choice.value === null && !second_query) {
                            return "district_reenter";
                        }
                        return "facility_type";
                    },
                    _.gettext("The district you entered cannot be found." +
                              " Did you mean:"),
                    choices, null, {},
                    {
                        more: im.i18n.gettext("View more"),
                        back: im.i18n.gettext("Back"),
                        options_per_page: self.options_per_page,
                        characters_per_page: self.characters_per_page
                    }
                );
            });
            return p;
        });
        self.add_state(new FreeText(
            "district_reenter",
            self.facility_or_district_select,
            _.gettext("Please re-enter your district:")
        ));
        self.add_creator("facility_type", function(state_name, im) {
            var _ = im.i18n;
            var swb_api = self.swb_api(im);
            var p = swb_api.list_facility_types();
            p.add_callback(function (facility_types) {
                var choices = facility_types.map(function (f) {
                    return new Choice(f.id, f.text);
                });
                choices[choices.length] = new Choice(null,
                                                     _.gettext("Other"));
                return new PaginatedChoiceState(
                    state_name,
                    "facility_name",
                    _.gettext("Please enter your facility type:"),
                    choices, null, {},
                    {
                        more: im.i18n.gettext("View more"),
                        back: im.i18n.gettext("Back"),
                        options_per_page: self.options_per_page,
                        characters_per_page: self.characters_per_page
                    }
                );
            });
            return p;
        });
        self.add_state(new FreeText(
            "facility_name",
            function (content, done) {
                var im = this.im;
                var swb_api = self.swb_api(im);
                var district = im.get_user_answer("district_select");
                var facility_type = im.get_user_answer("facility_type");
                var query = content;
                var p = swb_api.list_facilities(district, facility_type, query);
                p.add_callback(function (facilities) {
                    var ev_p = success();
                    if (facilities.length == 1) {
                        im.set_user_answer("facility_select", facilities[0].id);
                        ev_p.add_callback(function (result) {
                            var cadre_id = im.get_user_answer("cadre");
                            return swb_api.cadre_needs_specialties(cadre_id);
                        });
                        p.add_callback(function (needs_specialties) {
                            if (needs_specialties) {
                                done("select_speciality");
                            }
                            else {
                                done("session2_end");
                            }
                        });
                    }
                    else {
                        ev_p.add_callback(function (result) {
                            done("facility_select");
                        });
                    }
                    return ev_p;
                });
            },
            _.gettext("Please enter the official name of the facility where" +
                      " you primarily practice")
        ));
        self.add_creator("facility_select", function (state_name, im) {
            var _ = im.i18n;
            var swb_api = self.swb_api(im);
            var district = im.get_user_answer("district_select");
            var facility_type = im.get_user_answer("facility_type");
            var query = im.get_user_answer("facility_name");
            var p = swb_api.list_facilities(district, facility_type, query);
            p.add_callback(function (facilities) {
                var choices = facilities.map(function (f) {
                    return new Choice(f.id, f.text);
                });
                choices[choices.length] = new Choice(
                    null, im.i18n.gettext("None of the above"));

                return new PaginatedChoiceState(
                    state_name,
                    function (choice, done) {
                        var p = success();
                        if (choice.value === null) {
                            p.add_callback(function (result) {
                                return swb_api.submit_unknown_facility(
                                    im.user_addr, query, district,
                                    facility_type);
                            });
                        }
                        p.add_callback(function (result) {
                            var cadre_id = im.get_user_answer("cadre");
                            return swb_api.cadre_needs_specialties(cadre_id);
                        });
                        p.add_callback(function (needs_specialties) {
                            if (needs_specialties) {
                                done("select_speciality");
                            }
                            else {
                                done("session2_end");
                            }
                        });
                    },
                    _.gettext("The Facility you entered cannot be found." +
                              " Did you mean:"),
                    choices, null, {},
                    {
                        more: im.i18n.gettext("View more"),
                        back: im.i18n.gettext("Back"),
                        options_per_page: self.options_per_page,
                        characters_per_page: self.characters_per_page
                    }
                );
            });
            return p;
        });
        self.add_creator("select_speciality", function (state_name, im) {
            var _ = im.i18n;
            var swb_api = self.swb_api(im);
            var cadre_id = im.get_user_answer("cadre");
            var p = swb_api.list_specialities(cadre_id);
            p.add_callback(function (specialities) {
                var choices = specialities.map(function (s) {
                    return new Choice(s.id, s.text);
                });
                choices[choices.length] = new Choice(null,
                                                     _.gettext("Other"));
                return new PaginatedChoiceState(
                    state_name,
                    "session2_end",
                    _.gettext("Please enter your specialty:"),
                    choices, null, {},
                    {
                        more: im.i18n.gettext("View more"),
                        back: im.i18n.gettext("Back"),
                        options_per_page: self.options_per_page,
                        characters_per_page: self.characters_per_page
                    }
                );
            });
            return p;
        });
        self.add_state(new EndState(
            "session2_end",
            _.gettext("Thank you for registering with The Health Network" +
                      " Programme. We will verify your registration within 2" +
                      " weeks and confirm by SMS when you can make free" +
                      " calls."),
            function (content) {
                if (self.qa(this.im)) {
                    return "intro";
                }
                return "session2_end";
            },
            {
                on_enter: function () {
                    var im = this.im;
                    var swb_api = self.swb_api(im);
                    var health_worker = self.create_health_worker(im);
                    var p = swb_api.register_health_worker(health_worker);
                    p.add_callback(function () {
                        return self.send_sms_session2_end(im);
                    });
                    p.add_callback(function () {
                        return self.incr_metric(im, 'second_session_completed');
                    });
                    return p;
                }
            }
        ));

}


// launch app
var states = new RegisterHealthWorker();
var im = new InteractionMachine(api, states);
im.attach();
