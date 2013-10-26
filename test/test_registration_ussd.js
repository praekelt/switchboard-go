var fs = require("fs");
var assert = require("assert");
var app = require("../lib/switchboard-ussd");

var locale_data = {
    'en': fs.readFileSync('po/en/LC_MESSAGES/messages.json'),
    'sw': fs.readFileSync('po/sw/LC_MESSAGES/messages.json')
};

describe("test_api", function() {
    it("should exist", function() {
        assert.ok(app.api);
    });
    it("should have an on_inbound_message method", function() {
        assert.ok(app.api.on_inbound_message);
    });
    it("should have an on_inbound_event method", function() {
        assert.ok(app.api.on_inbound_event);
    });
});


function reset_im(im) {
    im.user = null;
    im.i18n = null;
    im.i18n_lang = null;
    im.current_state = null;
}

function fresh_api() {
    var api = app.api;
    api.reset();
    api.config_store["translation.en"] = locale_data.en;
    api.config_store["translation.sw"] = locale_data.sw;
    reset_im(api.im);
    return api;
}

function maybe_call(f, that, args) {
    if (typeof f != "undefined" && f !== null) {
        f.apply(that, args);
    }
}

function check_state(user, content, next_state, expected_response, setup,
                     teardown, session_event) {

    // Add lang if not present
    if (user != null && typeof user.lang === 'undefined') {
      user.lang = 'en';
    }

    // setup api
    var api = fresh_api();
    var from_addr = "1234567";
    var user_key = "users." + from_addr;
    api.kv_store[user_key] = user;

    maybe_call(setup, this, [api]);

    api.add_reply({
        cmd: "outbound.reply_to"
    });

    // send message
    session_event = ((typeof session_event != 'undefined')
                     ? session_event : "continue");
    api.on_inbound_message({
        cmd: "inbound-message",
        msg: {
            from_addr: from_addr,
            content: content,
            message_id: "123",
            session_event: session_event
        }
    });

    // check result
    var saved_user = api.kv_store[user_key];
    assert.equal(saved_user.current_state, next_state);
    var reply = api.request_calls.shift();
    var response = reply.content;
    try {
        assert.ok(response);
        assert.ok(response.match(expected_response));
        assert.ok(response.length <= 163);
    } catch (e) {
        console.log(api.logs);
        console.log(response);
        console.log(expected_response);
        if (typeof response != 'undefined')
            console.log("Content length: " + response.length);
        throw e;
    }
    assert.deepEqual(app.api.request_calls, []);
    assert.equal(app.api.done_calls, 1);

    maybe_call(teardown, this, [api, saved_user]);
}

function check_close(user, next_state, setup, teardown) {
    var api = fresh_api();
    var from_addr = "1234567";
    var user_key = "users." + from_addr;
    api.kv_store[user_key] = user;

    maybe_call(setup, this, [api]);

    // send message
    api.on_inbound_message({
        cmd: "inbound-message",
        msg: {
            from_addr: from_addr,
            session_event: "close",
            content: "User Timeout",
            message_id: "123"
        }
    });

    // check result
    var saved_user = api.kv_store[user_key];
    assert.equal(saved_user.current_state, next_state);
    assert.deepEqual(app.api.request_calls, []);
    assert.equal(app.api.done_calls, 1);

    maybe_call(teardown, this, [api, saved_user]);
}

function CustomTester(custom_setup, custom_teardown) {
    var self = this;

    self._combine_setup = function(custom_setup, orig_setup) {
        var combined_setup = function (api) {
            maybe_call(custom_setup, self, [api]);
            maybe_call(orig_setup, this, [api]);
        };
        return combined_setup;
    };

    self._combine_teardown = function(custom_teardown, orig_teardown) {
        var combined_teardown = function (api, saved_user) {
            maybe_call(custom_teardown, self, [api, saved_user]);
            maybe_call(orig_teardown, this, [api, saved_user]);
        };
        return combined_teardown;
    };

    self.check_state = function(user, content, next_state, expected_response,
                                setup, teardown, session_event) {
        return check_state(user, content, next_state, expected_response,
                           self._combine_setup(custom_setup, setup),
                           self._combine_teardown(custom_teardown, teardown),
                           session_event);
    };

    self.check_close = function(user, next_state, setup, teardown) {
        return check_close(user, next_state,
                           self._combine_setup(custom_setup, setup),
                           self._combine_teardown(custom_teardown, teardown));
    };
}


describe("test_ussd_states_for_session_1", function() {
    it("new users should see the intro state", function () {
        check_state(null, null, "intro", "^Welcome to the Health Network.");
    });
    it("intro state should respond", function() {
        check_state({current_state: "intro"}, null, "intro",
            "^Welcome to the Health Network. FREE calls brought to U by Switchboard," +
            " Ministry of Health, MAT and Vodacom.[^]" +
            "Please choose a language[^]" +
            "1. Swahili[^]" +
            "2. English$"
        );
    });
    it("reply 'foo' to intro should produce error text", function() {
        check_state({current_state: "intro"}, "foo", "intro",
            "^Please select a valid language.[^]" +
            "1. Swahili[^]" +
            "2. English$"
        );
    });
    it("cadre state should respond", function() {
        check_state({current_state: "cadre"}, null, "cadre",
            "^What CADRE are you\?[^][^]" +
            "1\\. Medical Specialist[^]*6. View more$"
        );
    });
    it("cadre state should show next page", function() {
        var user = {
            current_state: "cadre",
            pages: {
                cadre: 5
            }
        };
        check_state(user, null, "cadre",
            "^What CADRE are you\?[^][^]" +
            "1\\. Dental Specialist[^]*" +
            "6\\. Back$"
        );
    });
    it("reply 1 to cadre should go to first_name", function () {
        check_state({current_state: "cadre"}, "1", "first_name");
    });
    it("reply 5 to cadre should go to cadre_other", function () {
        check_state({current_state: "cadre", pages: {cadre: 5}},
                    "5", "cadre_other",
                    "^Please write the name of your CADRE or enter '0' to " +
                    "return to the list of CADRES:$"
        );
    });
    it("reply foo to cadre_other should go to cadre_unavailable", function () {
        check_state({current_state: "cadre_other"}, "foo", "cadre_unavailable",
            "^Sorry, this service is not yet available for your CADRE.",
            null,
            function (api, user) {
                assert.equal(user.answers.cadre_other, "foo");
            }
        );
    });
    it("reply 0 to cadre_other should go back to cadre", function () {
        check_state({current_state: "cadre_other"}, "0", "cadre");
    });
    it("cadre_unavailable should store cadre on yes", function () {
        check_state({current_state: "cadre_unavailable"}, "1",
                    "cadre_unavailable_contact");
    });
    it("cadre_unavailable should not store cadre on no", function () {
        check_state({current_state: "cadre_unavailable"}, "2",
                    "cadre_unavailable_dont_contact");
    });
    it("cadre_unavailable should go back to cadre on back", function () {
        check_state({current_state: "cadre_unavailable"}, "3", "cadre");
    });
    it("cadre_unavailable_contact should return to intro", function () {
        check_state({current_state: "cadre_unavailable_contact"}, "foo",
                    "intro",
                    "^Welcome to the Health Network."
        );
    });
    it("cadre_unavailable_dont_contact should return to intro", function () {
        check_state({current_state: "cadre_unavailable_dont_contact"}, "foo",
                    "intro",
                    "^Welcome to the Health Network."
        );
    });
    it("first_name should accept free text", function () {
        check_state({current_state: "first_name"}, "whee",
                    "surname", "^", null,
                    function (api, user) {
                        assert.equal(user.answers.first_name, "whee");
                    });
    });
    it("surname should accept free text and go to cheque_number", function () {
        check_state({current_state: "surname"}, "whoa",
                    "cheque_number", 
                    "^To verify U are a government worker enter last 7-9 digits of your cheque no " +
                    "\\(eg 1234567\\). Enter '0' if U do not have a cheque no or are not a government " +
                    "worker$",
                    null,
                    function (api, user) {
                        assert.equal(user.answers.surname, "whoa");
                    });
    });
    it("cheque_number should store valid input", function () {
        check_state({current_state: "cheque_number"}, "1234567",
                    "terms_and_conditions", "^", null,
                    function (api, user) {
                        assert.equal(user.answers.cheque_number,
                                     "1234567");
                    });
    });
    it("cheque_number should reject invalid input", function () {
        check_state({current_state: "cheque_number"}, "123456",
                    "cheque_number", "^", null
                   );
    });
    it("cheque_number should skip on 0", function () {
        check_state({current_state: "cheque_number"}, "0",
                    "registration_number",
                    "^To verify U are a registered health worker enter your Medical Council of " +
                    "Tanganyika REGISTRATION # \\(eg 1234\\). Enter '0' if U do not have a " +
                    "Registration Number$",
                    null,
                    function (api, user) {
                        assert.equal(user.answers.cheque_number,
                                     "0");
                    });
    });
    it("registration_number should accept valid input and go to terms_and_conditions", function () {
        check_state({current_state: "registration_number"}, "1234",
                    "terms_and_conditions", "^", null,
                    function (api, user) {
                        assert.equal(user.answers.registration_number,
                                     "1234");
                    });
    });
    it("registration_number should reject invalid input", function () {
        check_state({current_state: "registration_number"}, "123456",
                    "registration_number");
    });
    it("registration_number should skip on 0", function () {
        check_state({current_state: "registration_number"}, "0",
                    "terms_and_conditions");
    });
    it("dont_match_mct should go to cheque_number on 1", function () {
        check_state({current_state: "dont_match_mct"}, "1",
                    "cheque_number");
    });
    it("dont_match_mct should go to dont_match_mct_end on 2", function () {
        check_state({current_state: "dont_match_mct"}, "2",
                    "dont_match_mct_end");
    });
    it("dont_match_mct_end should return to intro", function () {
        check_state({current_state: "dont_match_mct_end"}, "1",
                    "intro", "^");
    });
    it("reply foo to terms_and_conditions should redisplay state", function() {
        check_state({current_state: "terms_and_conditions"}, "foo",
            "terms_and_conditions",
            "^Do you agree to the terms and conditions as laid [^]*" +
            "1. Yes[^]" +
            "2. No$"
        );
    });
    it("reply 1 to terms_and_conditions should end session1", function() {
        check_state({current_state: "terms_and_conditions"}, "1",
            "session1_end",
            "^Thank you. You have almost completed your registration process."
        );
    });
    it("reply 2 to terms_and_conditions should abort session1", function() {
        check_state({current_state: "terms_and_conditions"}, "2",
            "session1_abort_yn",
            "^We are sorry but you cannot be registered unless you agree to" +
            " the terms and conditions."
        );
    });
    it("session1_abort_yn should abort on 1", function () {
        check_state({current_state: "session1_abort_yn"}, "1",
                    "session1_abort");
    });
    it("session1_abort_yn should return to t&c on 2", function () {
        check_state({current_state: "session1_abort_yn"}, "2",
                    "terms_and_conditions");
    });
    it("session1_abort should return to intro", function () {
        check_state({current_state: "session1_abort"}, "foo",
                    "intro");
    });
    it("session1_end should go to session2_intro", function () {
        check_state({current_state: "session1_end"}, "foo",
                    "session2_intro");
    });
});

describe("test_ussd_states_for_session_2", function() {
    it("session2_intro should go to district_select on non-match", function () {
        check_state({current_state: "session2_intro"}, "foo",
                    "district_select",
                    "^The district you entered cannot be found[^]*" +
                    "1. Kigoma MC[^]*" +
                    "4. None of the above");
    });
    it("district_select should go to facility_type on 1", function () {
        check_state({current_state: "district_select"}, "1",
                    "facility_type");
    });
    it("district_select should go to district_reenter on 4", function () {
        check_state({current_state: "district_select"}, "4",
                    "district_reenter",
                    "^Please re-enter your district:");
    });
    it("district_select should go to facility_type on 4 if not first select",
       function () {
           var user = {
               current_state: "district_select",
               answers: {
                   district_reenter: "foo"
               }
           };
           check_state(user, "4",
                       "facility_type",
                       "^Please enter your facility type:");
    });
    it("district_reenter should go to district_select", function () {
        check_state({current_state: "district_reenter"}, "foo",
                    "district_select",
                    "^The district you entered cannot be found[^]*" +
                    "1. Kigoma MC[^]*" +
                    "4. None of the above");
    });
    it("facility_type should show 5 options per menu", function () {
        check_state({current_state: "district_select"}, "1",
                    "facility_type",
                    "Please enter your facility type:[^]*" +
                    "1. Hospital[^]*" +
                    "6. View more");
    });
    it("facility_type should show page 2 on 6", function () {
        check_state({current_state: "facility_type"}, "6",
                    "facility_type",
                    "Please enter your facility type:[^]*" +
                    "1. Council[^]*" +
                    "5. Other[^*]" +
                    "6. Back");
    });
    it("facility_type pg 2 should show page 1 on 6", function () {
        var user = {
            current_state: "facility_type",
            pages: {
                facility_type: 5
            }
        };
        check_state(user, "6",
                    "facility_type",
                    "Please enter your facility type:[^]*" +
                    "1. Hospital[^]*" +
                    "6. View more");
    });
    it("facility_name should go to facility_select on generic input",
       function () {
           check_state({current_state: "facility_name"}, "facility1",
                       "facility_select",
                       "The Facility you entered cannot be found." +
                       " Did you mean:[^]*" +
                       "1. Wazazi Galapo[^]*" +
                       "4. None of the above");
    });
    it("facility_select should go to select_speciality" +
       " if cadre == ms", function () {
           var user = {
               current_state: "facility_select",
               answers: {cadre: 1}
           };
           check_state(user, "1", "select_speciality", "[^]*3. Other[^]*");
    });
    it("facility_select should go to select_speciality" +
       " if cadre == amo", function () {
           var user = {
               current_state: "facility_select",
               answers: {cadre: 60}
           };
           check_state(user, "1", "select_speciality", "[^]*3. Other[^]*");
    });
    it("facility_select should go to select_speciality" +
       " if cadre == ds", function () {
           var user = {
               current_state: "facility_select",
               answers: {cadre: 67}
           };
           check_state(user, "1", "select_speciality", "[^]*3. Other[^]*");
    });
    it("facility_select should go to session2_end" +
       " if cadre == mo", function () {
           var user = {
               current_state: "facility_select",
               answers: {cadre: "mo"}
           };
           check_state(user, "1", "session2_end", "[^]*");
    });
    it("facility_select should go to session2_end if cadre == mo and" +
       " None of the above is selected", function () {
           var user = {
               current_state: "facility_select",
               answers: {cadre: "mo"}
           };
           check_state(user, "4", "session2_end", "[^]*");
    });
    it("select_speciality should go to session2_end on valid input", function () {
        var user = {
            current_state: "select_speciality"
        };
        check_state(user, "1", "session2_end");
    });
    it("session2_end should remain in session2_end", function () {
        var user = {
            current_state: "session2_end",
            custom: {registered: 1}
        };
        check_state(user, "foo", "session2_end");
    });
});

describe("test_en_translation", function() {
    it("intro state should respond with translated text", function() {
        check_state({current_state: "intro"}, null, "intro",
            "^Welcome to the Health Network. FREE calls brought to U by Switchboard, " +
            "Ministry of Health, MAT and Vodacom.[^]" +
            "Please choose a language"
        );
    });
    it("cadre state should respond with translated cadre", function() {
        check_state({current_state: "intro"}, "2", "cadre",
                    "^What CADRE are you");
    });
});

describe("test_sw_translation", function() {
    it("intro state should respond with translated text", function() {
        check_state({current_state: "intro", lang: "sw"}, null, "intro",
            "^Karibu Mtandao wa Afya. Upigaji BURE wa simu unaletwa " + 
            "kwako na Wizara ya Afya, Switchboard, MAT na Vodacom.[^]" +
            "Tafadhali chagua lugha"
        );
    });
    it("cadre state should respond with translated cadre", function() {
        check_state({current_state: "intro"}, "1", "cadre",
                    "^Wewe ni kada lipi\?");
    });
});

describe("test_vodacom_number_check", function() {
    it("intro should respond with cadre if no patterns", function() {
        check_state({current_state: "intro"}, "1", "cadre", "[^]*",
            function (api) {
                api.config_store.config = JSON.stringify({
                    valid_user_addresses: []
                });
            }
        );
    });
    it("intro should respond with cadre if a pattern matches", function() {
        check_state({current_state: "intro"}, "1", "cadre", "[^]*",
            function (api) {
                api.config_store.config = JSON.stringify({
                    valid_user_addresses: ['^$', '^12345.*$']
                });
            }
        );
    });
    it("intro should respond with no_vodacom_sim otherwise", function() {
        check_state({current_state: "intro"}, "1", "no_vodacom_sim", "[^]*",
            function (api) {
                api.config_store.config = JSON.stringify({
                    valid_user_addresses: ['^$', '^abc']
                });
            }
        );
    });

});

describe("test_switchboard_api", function() {

    var fixtures = [
        "test/fixtures/specialties.json",
        "test/fixtures/districts-ar.json",
        "test/fixtures/facility-types.json",
        "test/fixtures/facilities-far-noregion.json",
        "test/fixtures/facilities-kil-8628.json",
        "test/fixtures/mct-registrations-3320.json",
        "test/fixtures/mct-payrolls-1523120.json",
        "test/fixtures/facilities-post-far.json",
        "test/fixtures/specialties-post-new-cadre.json",
        "test/fixtures/health-workers-post-1.json",
        "test/fixtures/health-workers-post-2.json",
        "test/fixtures/health-workers-post-3.json"
    ];

    var tester = new CustomTester(function (api) {
        api.config_store.config = JSON.stringify({
            swb_api: {
                url: "http://example.com/api/",
                username: "testuser",
                password: "testpass"
            }
        });
        fixtures.forEach(function (f) {
            api.load_http_fixture(f);
        });
    });

    it("intro should respond with list of cadres", function() {
        tester.check_state({current_state: "intro"}, "2", "cadre",
                           "^What CADRE are you\?[^][^]" +
                           "1\\. Assistant Clinical Officer[^]*6. View more$"
                          );
    });
    it("districts should be listed", function() {
        tester.check_state(
            {current_state: "session2_intro"},
            "Ar",
            "district_select",
            "^The district you entered cannot be found[^]*" +
            "1. Arusha DC[^]*" +
            "2. Arusha MC[^]*" +
            "3. None of the above$"
        );
    });
    it("facility types should be listed", function() {
        tester.check_state(
            {current_state: "facility_type"},
            null,
            "facility_type",
            "^Please enter your facility type:[^]*" +
            "1. Clinic[^]2. Dental Clinic[^]*" +
            "6. View more$"
        );
    });
    it("facilities should be listed (no district)", function() {
        tester.check_state(
            {
                current_state: "facility_name",
                answers: {"facility_type": 4}
            },
            "Far",
            "facility_select",
            "^The Facility you entered cannot be found. Did you mean:[^]*" +
            "1. Faraja[^]" +
            "2. Farkwa Ilala[^]" +
            "3. Farkwa Mkombwe[^]" +
            "4. Faraja[^]" +
            "5. None of the above$"
        );
    });
    it("facilities should be listed (with district)", function() {
        tester.check_state(
            {
                current_state: "facility_name",
                answers: {district_select: 8628}
            },
            "Kil",
            "facility_select",
            "^The Facility you entered cannot be found. Did you mean:[^]*" +
            "1. Kilimamoja[^]" +
            "2. Kilinga[^]" +
            "3. None of the above$"
        );
    });
    it("specialties are needed for cadre 1", function() {
        tester.check_state(
            {
                current_state: "facility_select",
                answers: {
                    cadre: 1,
                    facility_name: "Far",
                    facility_type: 4,
                    district_select: null
                }
            },
            "1",
            "select_speciality",
            "^Please enter your specialty:[^]" +
            "1. Anesthesiology[^]" +
            "2. Emergency medicine[^]*" +
            "6. View more$"
        );
    });
    it("specialties are not needed for cadre 2", function() {
        tester.check_state(
            {
                current_state: "facility_select",
                answers: {
                    cadre: 2,
                    facility_name: "Far",
                    facility_type: 4,
                    district_select: null,
                    first_name: "New",
                    surname: "User"
                }
            },
            "1",
            "session2_end"
        );
    });
    it("specialties should be listed", function() {
        tester.check_state(
            {
                current_state: "select_speciality",
                answers: {cadre: 1}
            },
            null,
            "select_speciality",
            "^Please enter your specialty:[^]" +
            "1. Anesthesiology[^]" +
            "2. Emergency medicine[^]*" +
            "6. View more$"
        );
    });
    it("unknown cadres should be submitted", function() {
        tester.check_state(
            {
                current_state: "cadre_unavailable",
                answers: {
                    cadre_other: "New Cadre",
                }
            },
            "1",
            "cadre_unavailable_contact"
        );
    });
    it("unknown facilities should be submitted", function() {
        tester.check_state(
            {
                current_state: "facility_select",
                answers: {
                    facility_name: "Far",
                    facility_type: 4,
                    district_select: null,
                    cadre: 2,
                    first_name: "New",
                    surname: "User",
                }
            },
            "5",
            "session2_end"
        );
    });
});

describe("test_sms_sending", function() {

    var tester = new CustomTester(
        function (api) {
            api.config_store.config = JSON.stringify({
                sms_tag: ["pool1", "3456"]
            });
        },
        function (api) {
            assert.ok(api.outbound_sends.every(
                function (send) {
                    return (send.tagpool == "pool1" &&
                            send.tag == "3456" &&
                            send.to_addr == "1234567");
                }
            ));
        }
    );

    var assert_single_sms = function(content) {
        var teardown = function(api) {
            var sms = api.outbound_sends[0];
            assert.equal(api.outbound_sends.length, 1);
            assert.equal(sms.content, content);
        };
        return teardown;
    };

    it("session 1 abort should send sms", function() {
        tester.check_state(
            {current_state: "session1_abort_yn"},
            "1", "session1_abort",
            "^If you would like to register at a later date" +
            " please dial \\*149\\*24#\\.$",
            null,
            assert_single_sms("If you would like to register at a later" +
                              " date please dial *149*24#.")
        );
    });
    it("session 1 end should send sms", function() {
        tester.check_state(
            {current_state: "terms_and_conditions"},
            "1", "session1_end",
            "Thank you. You have almost completed your " +
            "registration process. Please dial \\*149\\*24# " +
            "again to complete just a few more questions\\.",
            null,
            assert_single_sms("Thank you for beginning your registration" +
                              " process. Please dial *149*24# again to" +
                              " complete your registration in a few easy" +
                              " steps.")
        );
    });
    it("session 2 end should send sms", function() {
        var user = {
            current_state: "facility_select",
            answers: {cadre: "mo"}
        };
        tester.check_state(
            user,
            "1", "session2_end",
            "Thank you for registering with The Health Network Programme." +
            " We will verify your registration within 2 weeks and confirm by" +
            " SMS when you can make free calls.",
            null,
            assert_single_sms("Thank you for registering with The Health" +
                              " Network Programme. We will verify your" +
                              " registration within 2 weeks and confirm by" +
                              " SMS when you can make free calls.")
        );
    });

    it("first user timeout should send an sms", function() {
        tester.check_close(
            {}, "intro", null,
            function (api, saved_user) {
                assert_single_sms("Your session has ended but you have not" +
                                  " completed your registration. Please dial" +
                                  " *149*24# again to continue with your" +
                                  " registration where you left off.")(api);
                assert.deepEqual(saved_user.custom.possible_timeouts, 1);
            }
        );
    });
    it("second user timeout should not send an sms", function() {
        tester.check_close(
            {custom: {possible_timeouts: 1}}, "intro", null,
            function (api) {
                assert.deepEqual(api.outbound_sends, []);
            }
        );
    });
});

describe("test_metrics_firing", function() {
    var tester = new CustomTester();

    var assert_metric = function(metric, agg, values) {
        var teardown = function(api) {
            var store = api.metrics['default'];
            assert.ok(store[metric]);
            assert.equal(store[metric].agg, agg);
            assert.deepEqual(store[metric].values, values);
        };
        return teardown;
    };

    it("should fire a metric at the end of the first session", function () {
        tester.check_state(
            {current_state: "terms_and_conditions"},
            "1", "session1_end",
            "", null,
            assert_metric("first_session_completed", "max", [1])
        );
    });
    it("should fire a metric at the end of the second session", function() {
        var user = {
            current_state: "facility_select",
            answers: {cadre: "mo"}
        };
        tester.check_state(
            user,
            "1", "session2_end",
            "", null,
            assert_metric("second_session_completed", "max", [1])
        );
    });
    it("new user should fire a metric", function() {
        tester.check_state(
            {}, null, "intro", "",
            function (api) {
                var user_key = "users.1234567";
                delete api.kv_store[user_key];
            },
            assert_metric("unique_users", "max", [1])
        );

    });
    it("new session should fire a metric", function() {
        tester.check_state(
            {}, null, "intro", "", null,
            assert_metric("ussd_sessions", "max", [1]),
            "new"
        );
    });
});
