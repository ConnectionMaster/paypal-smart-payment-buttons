/* @flow */
/* eslint max-lines: off, max-nested-callbacks: off */

import { uniqueID, memoize, stringifyError,
    stringifyErrorMessage, cleanup, noop } from 'belter/src';
import { ZalgoPromise } from 'zalgo-promise/src';
import { FPTI_KEY } from '@paypal/sdk-constants/src';
import { type CrossDomainWindowType } from 'cross-domain-utils/src';

import { updateButtonClientConfig } from '../../api';
import { getLogger, promiseNoop, isAndroidChrome, getStorageState, briceLog } from '../../lib';
import { FPTI_STATE, FPTI_TRANSITION, FPTI_CUSTOM_KEY, TARGET_ELEMENT, QRCODE_STATE } from '../../constants';
import { type OnShippingChangeData } from '../../props/onShippingChange';
import { checkout } from '../checkout';
import type { PaymentFlow, PaymentFlowInstance, SetupOptions, InitOptions } from '../types';
import { updateQRCodeComponent } from '../../qrcode';

import { isNativeEligible, isNativePaymentEligible, prefetchNativeEligibility, canUseVenmoDesktopPay } from './eligibility';
import { openNativePopup } from './popup';
import { getNativePopupUrl } from './url';
import { connectNative } from './socket';

let clean;

function setupNative({ props, serviceData } : SetupOptions) : ZalgoPromise<void> {
    briceLog('payment-flows/native.js/setupNative');
    return prefetchNativeEligibility({ props, serviceData }).then(noop);
}

function initNative({ props, components, config, payment, serviceData } : InitOptions) : PaymentFlowInstance {
    briceLog('payment-flows/native.js/initNative');
    const { onApprove, onCancel, onError,
        buttonSessionID, onShippingChange } = props;
    const { fundingSource } = payment;
    const { firebase: firebaseConfig } = config;

    const isVenmoDesktopPay = canUseVenmoDesktopPay(fundingSource);

    if (!firebaseConfig) {
        throw new Error(`Can not run native flow without firebase config`);
    }

    if (clean) {
        clean.all();
    }

    clean = cleanup();

    let approved = false;
    let cancelled = false;
    let didFallback = false;

    const destroy = memoize(() => {
        return clean.all();
    });

    const fallbackToWebCheckout = (fallbackWin? : ?CrossDomainWindowType) => {
        briceLog('payment-flows/native.js/initNative -> fallbackToWebCheckout');

        didFallback = true;
        const checkoutPayment = { ...payment, win: fallbackWin, isClick: false, isNativeFallback: true };
        const instance = checkout.init({ props, components, payment: checkoutPayment, config, serviceData });
        clean.register(() => instance.close());
        return instance.start();
    };

    const onApproveCallback = ({ data: { payerID, paymentID, billingToken } }) => {
        approved = true;

        getLogger().info(`native_message_onapprove`, { payerID, paymentID, billingToken })
            .track({
                [FPTI_KEY.TRANSITION]:      FPTI_TRANSITION.NATIVE_ON_APPROVE,
                [FPTI_CUSTOM_KEY.INFO_MSG]: `payerID: ${ payerID }, paymentID: ${ paymentID || 'undefined' }, billingToken: ${ billingToken || 'undefined' }`
            })
            .flush();

        const data = { payerID, paymentID, billingToken, forceRestAPI: true };
        const actions = { restart: () => fallbackToWebCheckout() };
        return ZalgoPromise.all([
            onApprove(data, actions).catch(err => {
                getLogger().info(`native_message_onapprove_error`, { payerID, paymentID, billingToken })
                    .track({
                        [FPTI_KEY.TRANSITION]:      FPTI_TRANSITION.NATIVE_ON_APPROVE_ERROR,
                        [FPTI_CUSTOM_KEY.INFO_MSG]: `Error: ${ stringifyError(err) }`
                    })
                    .flush();
                onError(err);
            }),
            destroy()
        ]).then(() => {
            return { buttonSessionID };
        });
    };

    const onCancelCallback = () => {
        briceLog('payment-flows/native.js/initNative -> onCancelCallback');
        cancelled = true;
        getLogger().info(`native_message_oncancel`)
            .track({
                [FPTI_KEY.TRANSITION]:  FPTI_TRANSITION.NATIVE_ON_CANCEL
            })
            .flush();

        return ZalgoPromise.all([
            onCancel(),
            destroy()
        ]).then(() => {
            return { buttonSessionID };
        });
    };

    const onErrorCallback = ({ data : { message } } : {| data : {| message : string |} |}) => {
        briceLog('payment-flows/native.js/initNative -> onErrorCallback');
        getLogger().info(`native_message_onerror`, { err: message })
            .track({
                [FPTI_KEY.TRANSITION]:       FPTI_TRANSITION.NATIVE_ON_ERROR,
                [FPTI_CUSTOM_KEY.INFO_MSG]: `Error message: ${ message }`
            }).flush();

        return ZalgoPromise.all([
            onError(new Error(message)),
            destroy()
        ]).then(() => {
            return { buttonSessionID };
        });
    };

    const onShippingChangeCallback = ({ data } : {| data : OnShippingChangeData |}) => {
        return ZalgoPromise.try(() => {
            getLogger().info(`native_message_onshippingchange`)
                .track({
                    [FPTI_KEY.TRANSITION]:  FPTI_TRANSITION.NATIVE_ON_SHIPPING_CHANGE
                }).flush();

            if (onShippingChange) {
                let resolved = true;
                const actions = {
                    resolve: () => {
                        return ZalgoPromise.try(() => {
                            resolved = true;
                        });
                    },
                    reject: () => {
                        return ZalgoPromise.try(() => {
                            resolved = false;
                        });
                    }
                };
                return onShippingChange({ ...data, forceRestAPI: true }, actions).then(() => {
                    return {
                        resolved
                    };
                });
            } else {
                return {
                    resolved: true
                };
            }
        });
    };

    const onFallbackCallback = () => {
        return ZalgoPromise.try(() => {
            getLogger().info(`native_message_onfallback`)
                .track({
                    [FPTI_KEY.TRANSITION]:  FPTI_TRANSITION.NATIVE_ON_FALLBACK
                }).flush();
            fallbackToWebCheckout();
            return { buttonSessionID };
        });
    };

    const detectAppSwitch = ({ sessionUID } : {| sessionUID : string |}) : ZalgoPromise<void> => {
        getStorageState(state => {
            const { lastAppSwitchTime = 0, lastWebSwitchTime = 0 } = state;

            if (lastAppSwitchTime > lastWebSwitchTime) {
                getLogger().info('app_switch_detect_with_previous_app_switch', {
                    lastAppSwitchTime: lastAppSwitchTime.toString(),
                    lastWebSwitchTime: lastWebSwitchTime.toString()
                });
            }

            if (lastWebSwitchTime > lastAppSwitchTime) {
                getLogger().info('app_switch_detect_with_previous_web_switch', {
                    lastAppSwitchTime: lastAppSwitchTime.toString(),
                    lastWebSwitchTime: lastWebSwitchTime.toString()
                });
            }

            if (!lastAppSwitchTime && !lastWebSwitchTime) {
                getLogger().info('app_switch_detect_with_no_previous_switch', {
                    lastAppSwitchTime: lastAppSwitchTime.toString(),
                    lastWebSwitchTime: lastWebSwitchTime.toString()
                });
            }

            state.lastAppSwitchTime = Date.now();
        });

        getLogger().info(`native_detect_app_switch`).track({
            [FPTI_KEY.TRANSITION]:      FPTI_TRANSITION.NATIVE_DETECT_APP_SWITCH
        }).flush();

        const connection = connectNative({
            props, serviceData, config, fundingSource, sessionUID,
            callbacks: {
                onApprove:        onApproveCallback,
                onCancel:         onCancelCallback,
                onError:          onErrorCallback,
                onFallback:       onFallbackCallback,
                onShippingChange: onShippingChangeCallback
            }
        });

        clean.register(connection.cancel);

        return connection.setProps();
    };

    const detectWebSwitch = ({ win } : {| win : CrossDomainWindowType |}) : ZalgoPromise<void> => {
        getStorageState(state => {
            const { lastAppSwitchTime = 0, lastWebSwitchTime = 0 } = state;

            if (lastAppSwitchTime > lastWebSwitchTime) {
                getLogger().info('web_switch_detect_with_previous_app_switch', {
                    lastAppSwitchTime: lastAppSwitchTime.toString(),
                    lastWebSwitchTime: lastWebSwitchTime.toString()
                });
            }

            if (lastWebSwitchTime > lastAppSwitchTime) {
                getLogger().info('web_switch_detect_with_previous_web_switch', {
                    lastAppSwitchTime: lastAppSwitchTime.toString(),
                    lastWebSwitchTime: lastWebSwitchTime.toString()
                });
            }

            if (!lastAppSwitchTime && !lastWebSwitchTime) {
                getLogger().info('web_switch_detect_with_no_previous_switch', {
                    lastAppSwitchTime: lastAppSwitchTime.toString(),
                    lastWebSwitchTime: lastWebSwitchTime.toString()
                });
            }

            state.lastWebSwitchTime = Date.now();
        });

        getLogger().info(`native_detect_web_switch`).track({
            [FPTI_KEY.TRANSITION]: FPTI_TRANSITION.NATIVE_DETECT_WEB_SWITCH
        }).flush();

        return fallbackToWebCheckout(win);
    };

    const onCloseCallback = () => {
        briceLog('payment-flows/native.js/initNative -> onCloseCallback');

        return ZalgoPromise.delay(1000).then(() => {
            briceLog('payment-flows/native.js/initNative -> onCloseCallback -> in promise', true);
            
            if (!approved && !cancelled && !didFallback && !isAndroidChrome()) {
                return ZalgoPromise.all([
                    onCancel(),
                    destroy()
                ]);
            }
        }).then(noop);
    };

    const initQRCode = ({ sessionUID } : {| sessionUID : string |}) => {
        briceLog('payment-flows/native.js/initNative -> initQRCode ');
        const { QRCode } = components;
        const url = getNativePopupUrl({ props, serviceData, fundingSource });
        const QRCodeRenderTarget = window.xprops.getParent();

        getLogger().info(`VenmoDesktopPay_qrcode`).track({
            [FPTI_KEY.TRANSITION]:      FPTI_TRANSITION.VENMO_DESKTOP_PAY_QR_SHOWN
        }).flush();

        const QRCodeComponentInstance = QRCode({
            cspNonce:  config.cspNonce,
            qrPath:    url,
            state:     QRCODE_STATE.DEFAULT
        });
        
        QRCodeComponentInstance.renderTo(QRCodeRenderTarget, TARGET_ELEMENT.BODY);


        const closeQRCode = (event : string) => {
            getLogger().info(`VenmoDesktopPay_qrcode_closing_${ event }`).track({
                [FPTI_KEY.STATE]:       FPTI_STATE.BUTTON,
                [FPTI_KEY.TRANSITION]:  event ? `${ FPTI_TRANSITION.VENMO_DESKTOP_PAY_CLOSING_QR }_${ event }` : FPTI_TRANSITION.VENMO_DESKTOP_PAY_CLOSING_QR
            }).flush();
            onCloseCallback();
            QRCodeComponentInstance.close();
        };
        const onApproveQR = (res) => {
            updateQRCodeComponent({
                componentWindow: QRCodeRenderTarget,
                newState:        QRCODE_STATE.AUTHORIZED
            });
            closeQRCode('onApprove');
            return onApproveCallback(res);
        };
        const onCancelQR = () => {
            closeQRCode('onCancel');
            return onCancelCallback();
        };
        const onErrorQR = (res) => {
            const errorMessageText = res.data.message;
            updateQRCodeComponent({
                componentWindow: QRCodeRenderTarget,
                newState:        QRCODE_STATE.ERROR,
                errorMessageText
            });
            return onErrorCallback(res);
        };

        const connection = connectNative({
            props, serviceData, config, fundingSource, sessionUID,
            callbacks: {
                onApprove:        onApproveQR.then(() => clean.register(connection.cancel)),
                onCancel:         onCancelQR.then(() => clean.register(connection.cancel)),
                onError:          onErrorQR.then(() => clean.register(connection.cancel)),
                onFallback:       onFallbackCallback.then(() => clean.register(connection.cancel)),
                onShippingChange: onShippingChangeCallback.then(() => clean.register(connection.cancel))
            }
        });
        clean.register(connection.cancel);
    };

    const initPopupAppSwitch = ({ sessionUID } : {| sessionUID : string |}) => {
        briceLog('payment-flows/native.js/initNative -> initPopupAppSwitch ');
        return new ZalgoPromise((resolve, reject) => {
            const nativePopup = openNativePopup({
                props, serviceData, config, fundingSource, sessionUID,
                callbacks: {
                    onDetectWebSwitch: ({ win }) => detectWebSwitch({ win }).then(resolve, reject),
                    onDetectAppSwitch: () => detectAppSwitch({ sessionUID }).then(resolve, reject),
                    onApprove:         onApproveCallback,
                    onCancel:          onCancelCallback,
                    onError:           onErrorCallback,
                    onFallback:        onFallbackCallback,
                    onClose:           onCloseCallback,
                    onDestroy:         destroy
                }
            });

            clean.register(nativePopup.cancel);
        });
    };
    

    const click = () => {
        briceLog('payment-flows/native.js/initNative -> click ');
        
        return ZalgoPromise.try(() => {
            const sessionUID = uniqueID();
            return isVenmoDesktopPay ? initQRCode({ sessionUID }) : initPopupAppSwitch({ sessionUID });
        }).catch(err => {
            return destroy().then(() => {
                getLogger().error(`native_error`, { err: stringifyError(err) }).track({
                    [FPTI_KEY.TRANSITION]: FPTI_TRANSITION.NATIVE_ERROR,
                    [FPTI_KEY.ERROR_CODE]: 'native_error',
                    [FPTI_KEY.ERROR_DESC]: stringifyErrorMessage(err)
                }).flush();

                throw err;
            });
        });
    };

    const start = promiseNoop;

    return {
        click,
        start,
        close: destroy
    };
}

function updateNativeClientConfig({ orderID, payment, userExperienceFlow, buttonSessionID }) : ZalgoPromise<void> {
    briceLog('payment-flows/native.js/updateNativeClientConfig');

    return ZalgoPromise.try(() => {
        const { fundingSource } = payment;
        return updateButtonClientConfig({ fundingSource, orderID, inline: false, userExperienceFlow, buttonSessionID });
    });
}

export const native : PaymentFlow = {
    name:                   'native',
    setup:                  setupNative,
    isEligible:             isNativeEligible,
    isPaymentEligible:      isNativePaymentEligible,
    init:                   initNative,
    updateFlowClientConfig: updateNativeClientConfig,
    spinner:                true
};
