/* @flow */
/* eslint require-await: off, max-lines: off, max-nested-callbacks: off */

import { INTENT } from '@paypal/sdk-constants/src';

import { getButtonProps } from './props';

describe('getButtonProps', () => {
    const brandedDefault = true;
    const facilitatorAccessToken = 'ABCDEFG12345';

    it('should fail if createBillingAgreement & createOrder are both passed in', () => {
        global.xprops = {};
        global.xprops.createBillingAgreement = () => {
            return 'ok';
        };
        global.xprops.createOrder = () => {
            return 'ok';
        };
        expect(() => getButtonProps({ facilitatorAccessToken, brandedDefault })).toThrowError();
    });

    it('should fail if createBillingAgreement is passed in but not vault', () => {
        global.xprops = {};
        global.xprops.createBillingAgreement = () => {
            return 'ok';
        };
        expect(() => getButtonProps({ facilitatorAccessToken, brandedDefault })).toThrowError();
    });

    it('should fail if createSubscription & createOrder are both passed in', () => {
        global.xprops = {};
        global.xprops.createSubscription = () => {
            return 'ok';
        };
        global.xprops.createOrder = () => {
            return 'ok';
        };
        expect(() => getButtonProps({ facilitatorAccessToken, brandedDefault })).toThrowError();
    });

    it('should fail if createSubscription but not vault', () => {
        global.xprops = {};
        global.xprops.createSubscription = () => {
            return 'ok';
        };
        expect(() => getButtonProps({ facilitatorAccessToken, brandedDefault })).toThrowError();
    });

    it('should fail if intent is tokenize but no createBillingAgreement', () => {
        global.xprops = {};
        global.xprops.intent = INTENT.TOKENIZE;
        expect(() => getButtonProps({ facilitatorAccessToken, brandedDefault })).toThrowError();
    });

    it('should fail if intent is tokenize but contains createOrder', () => {
        global.xprops = {};
        global.xprops.intent = INTENT.TOKENIZE;
        global.xprops.createBillingAgreement = () => 'BA-1234';
        global.xprops.createOrder = () => 'ok';
        expect(() => getButtonProps({ facilitatorAccessToken, brandedDefault })).toThrowError();
    });

    it('should fail if intent is tokenize but contains createSubscription', () => {
        global.xprops = {};
        global.xprops.intent = INTENT.TOKENIZE;
        global.xprops.createBillingAgreement = () => 'BA-1234';
        global.xprops.createSubscription = () => 'ok';
        expect(() => getButtonProps({ facilitatorAccessToken, brandedDefault })).toThrowError();
    });

    it('should fail if intent is subscription but does not contain createSubscription', () => {
        global.xprops = {};
        global.xprops.intent = INTENT.SUBSCRIPTION;
        global.xprops.vault = true;
        expect(() => getButtonProps({ facilitatorAccessToken, brandedDefault })).toThrowError();
    });

    it('should fail if intent is subscription but contains createOrder', () => {
        global.xprops = {};
        global.xprops.intent = INTENT.SUBSCRIPTION;
        global.xprops.vault = true;
        global.xprops.createSubscription = () => 'ok';
        global.xprops.createOrder = () => 'ok';
        expect(() => getButtonProps({ facilitatorAccessToken, brandedDefault })).toThrowError();
    });

    it('should fail if intent is subscription but contains createBillingAgreement', () => {
        global.xprops = {};
        global.xprops.intent = INTENT.SUBSCRIPTION;
        global.xprops.vault = true;
        global.xprops.createSubscription = () => 'ok';
        global.xprops.createBillingAgreement = () => 'ok';
        expect(() => getButtonProps({ facilitatorAccessToken, brandedDefault })).toThrowError();
    });

    it('should fail if intent is subscription but contains createBillingAgreement', () => {
        global.xprops = {};
        global.xprops.intent = INTENT.SUBSCRIPTION;
        global.xprops.vault = true;
        global.xprops.createSubscription = () => 'ok';
        expect(() => getButtonProps({ facilitatorAccessToken, brandedDefault })).not.toThrowError();
    });
});
