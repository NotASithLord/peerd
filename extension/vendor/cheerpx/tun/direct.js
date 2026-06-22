"use strict";
/*Compiled using Cheerp (R) by Leaning Technologies Ltd*/
var __imul=Math.imul;
var __fround=Math.fround;
var oSlot=0;var nullArray=[null];var nullObj={d:nullArray,o:0};
var CHEERP_ENV=null,CHEERP_ARGV=null;
function __ZN16TailscaleNetwork9TCPSocketEPN6client6StringEj(Larg0,Larg1,Larg2){
	var tmp0=null,tmp1=null,tmp2=null;
	if(Larg0.a0!==null){
		tmp0={a0:null,a1:null,a2:null,a3:null,a4:null,a5:null,i6:0};
		__ZN16TailscaleNetwork10TCPWrapperC2EPS_(tmp0,Larg0);
		tmp2={a0:nullArray,a0o:0};
		__ZN16TailscaleNetwork10TCPWrapper7connectEPS_PN6client6StringEj(tmp2,tmp0,Larg0,Larg1,Larg2);
		tmp2=tmp0.a1.promise;
		tmp1=tmp0.a2.promise;
		return {opened :tmp2, closed :tmp1, close :tmp0.a5};
	}
	return null;
}
function __ZN16TailscaleNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsE(Larg0,Larg1,Larg2){
	var tmp0=0,tmp1=null,tmp2=null,tmp3=null;
	tmp3=undefined;
	if(Larg0.a0!==null){
		if(tmp3===Larg2)return null;
		if(Larg2.hasOwnProperty("localPort")){
			tmp0=Larg2.localPort;
			tmp3={a0:null,a1:null,a2:null,a3:null,a4:null,a5:null,i6:0};
			__ZN16TailscaleNetwork10TCPWrapperC2EPS_(tmp3,Larg0);
			__ZN16TailscaleNetwork10TCPWrapper6listenEPS_PN6client6StringEj(tmp3,Larg0,Larg1,tmp0);
			tmp1=tmp3.a1.promise;
			tmp2=tmp3.a2.promise;
			return {opened :tmp1, closed :tmp2, close :tmp3.a5};
		}
		return null;
	}
	return null;
}
function __ZN16TailscaleNetwork9UDPSocketEPN6client16UDPSocketOptionsE(Larg0,Larg1){
	var tmp0=0,tmp1=null,tmp2=null,tmp3=null;
	tmp3=undefined;
	if(Larg0.a0!==null){
		if(tmp3===Larg1)return null;
		if(Larg1.hasOwnProperty("localPort")){
			tmp0=Larg1.localPort;
			tmp3={a0:null,a1:null,a2:null,a3:null,a4:null,a5:null,i6:0};
			__ZN16TailscaleNetwork10UDPWrapperC2EPS_(tmp3,Larg0);
			__ZN16TailscaleNetwork10UDPWrapper4bindEPS_j(tmp3,Larg0,tmp0);
			tmp1=tmp3.a1.promise;
			tmp2=tmp3.a2.promise;
			return {opened :tmp1, closed :tmp2, close :tmp3.a5};
		}
		return null;
	}
	return null;
}
function __ZN16TailscaleNetwork2upEv(Larg0){
	var tmp0=null,L$poptgepsqueezed8=null,tmp2=null,tmp3=null;
	tmp2=new constructor__ZN16TailscaleNetwork2upEv$pFrame().a;
	tmp3=tmp2[0];
	tmp3.a0=__ZN16TailscaleNetwork2upEv$presume;
	tmp3.a1=__ZN16TailscaleNetwork2upEv$pdestroy;
	tmp3.a3=Larg0;
	tmp0=__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEv(tmp3.a2);
	L$poptgepsqueezed8=tmp3.a5;
	__ZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed8,tmp3.a3.a1);
	tmp3.i8=1;
	tmp3={a0:nullArray,a0o:0};
	__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_typeEE12from_addressB7v160000EPv(tmp3,tmp2,0);
	tmp2={a0:nullArray,a0o:0};
	__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_typeEEcvS_IvEB7v160000Ev(tmp2,tmp3);
	__ZZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed8,tmp2);
	return tmp0;
}
function __ZN16TailscaleNetwork3newEPN6client6ObjectE(Larg0){
	var tmp0=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN16TailscaleNetworkC1EPN6client6ObjectE(tmp0,Larg0);
	return tmp0;
}
function __ZN16TailscaleNetwork6deleteEv(Larg0){
}
function __ZN16TailscaleNetworkC1EPN6client6ObjectE(Larg0,Larg1){
	var tmp0=null,tmp1=null,tmp2=null;
	Larg0.a0=null;
	tmp1=__ZN6client20PromiseWithResolversIPNS_4_AnyEE6createEv();
	Larg0.a2=tmp1.promise;
	tmp2=Larg1["stateUpdateCb"];
	tmp0={a0:null,a1:null};
	tmp0.a0=tmp1;
	tmp0.a1=tmp2;
	tmp1=__ZN6cheerp8CallbackIZN16TailscaleNetworkC1EPN6client6ObjectEEUliE_EEPNS2_13EventListenerEOT_(tmp0);
	Larg1["stateUpdateCb"]=tmp1;
	tmp1=import('./tailscale_tun_auto.js');
	tmp2={a0:null,a1:null};
	tmp2.a0=Larg0;
	tmp2.a1=Larg1;
	Larg0.a1=tmp1.then(__ZN6cheerp8CallbackIZN16TailscaleNetworkC1EPN6client6ObjectEEUlPNS2_13IPNetworkConfEE_EEPNS2_13EventListenerEOT_(tmp2));
}
function __ZN6client20PromiseWithResolversIPNS_4_AnyEE6createEv(){
	return Promise.withResolvers();
}
function _cheerpCreate_ZN6client6StringC2EPKc(Larg0,Marg0){
	var tmp0=0,tmp1=0,tmp2=null;
	tmp2=String();
	tmp0=0;
	while(1){
		tmp1=Larg0[Marg0+tmp0|0]|0;
		if((tmp1&255)!==0){
			tmp2=tmp2.concat(String.fromCharCode(tmp1&255));
			tmp0=tmp0+1|0;
			continue;
		}
		break;
	}
	return tmp2;
}
function __ZN6cheerp8CallbackIZN16TailscaleNetworkC1EPN6client6ObjectEEUliE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetworkC1EPN6client6ObjectEEUliE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS6_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS6_Efp_EEEOS6_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFviEEcvPN6client13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFviEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp8CallbackIZN16TailscaleNetworkC1EPN6client6ObjectEEUlPNS2_13IPNetworkConfEE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetworkC1EPN6client6ObjectEEUlPNS2_13IPNetworkConfEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS8_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS8_Efp_EEEOS8_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_9IPNetworkEEEPNS1_13IPNetworkConfEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_9IPNetworkEEEPNS1_13IPNetworkConfEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIZN16TailscaleNetworkC1EPN6client6ObjectEEUlPNS2_13IPNetworkConfEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS8_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS8_Efp_EEEOS8_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetworkC1EPN6client6ObjectEEUlPNS2_13IPNetworkConfEE_MS7_KFPNS2_7PromiseIPNS2_9IPNetworkEEES6_EE12make_closureEOS7_(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_9IPNetworkEEEPNS1_13IPNetworkConfEEEcvPNS1_13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_9IPNetworkEEEPNS1_13IPNetworkConfEEE14deleter_helperEPNSA_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_9IPNetworkEEEPNS1_13IPNetworkConfEEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_9IPNetworkEEEPNS1_13IPNetworkConfEEE14deleter_helperEPNSA_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0,Larg1){
	var tmp0=null;
	tmp0=__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE9resourcesE;
	if(tmp0!==null){
		tmp0.set(Larg0,Larg1);
		return;
	}
	tmp0=new Map();
	__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE9resourcesE=tmp0;
	tmp0.set(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetworkC1EPN6client6ObjectEEUlPNS2_13IPNetworkConfEE_MS7_KFPNS2_7PromiseIPNS2_9IPNetworkEEES6_EE12make_closureEOS7_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_9IPNetworkEEEPNS1_13IPNetworkConfEEEC2IZN16TailscaleNetworkC1EPNS1_6ObjectEEUlS8_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISG_PS9_EE5valueEvE4typeEPNSJ_IXntsrNSA_13_must_destroyISG_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_9IPNetworkEEEPNS1_13IPNetworkConfEEEC2IZN16TailscaleNetworkC1EPNS1_6ObjectEEUlS8_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISG_PS9_EE5valueEvE4typeEPNSJ_IXntsrNSA_13_must_destroyISG_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null,a1:null}];
	tmp0[0].a0=Larg1.a0;
	tmp0[0].a1=Larg1.a1;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_9IPNetworkEEEE6invokeIZN16TailscaleNetworkC1EPNS1_6ObjectEEUlPNS1_13IPNetworkConfEE_JSD_EEES6_PT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_9IPNetworkEEEE6invokeIZN16TailscaleNetworkC1EPNS1_6ObjectEEUlPNS1_13IPNetworkConfEE_JSD_EEES6_PT_DpT0_(Larg0,Larg1){
	return __ZZN16TailscaleNetworkC1EPN6client6ObjectEENKUlPNS0_13IPNetworkConfEE_clES4_(Larg0,Larg1);
}
function __ZZN16TailscaleNetworkC1EPN6client6ObjectEENKUlPNS0_13IPNetworkConfEE_clES4_(Larg0,Larg1){
	return Larg1.autoConf(Larg0.a1);
}
function __ZN6cheerp12make_closureIZN16TailscaleNetworkC1EPN6client6ObjectEEUliE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS6_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS6_Efp_EEEOS6_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetworkC1EPN6client6ObjectEEUliE_MS5_KFviEE12make_closureEOS5_(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFviEEcvPN6client13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFviEE14deleter_helperEPNS2_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFviEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFviEE14deleter_helperEPNS2_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetworkC1EPN6client6ObjectEEUliE_MS5_KFviEE12make_closureEOS5_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFviEEC2IZN16TailscaleNetworkC1EPN6client6ObjectEEUliE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS9_PS1_EE5valueEvE4typeEPNSC_IXntsrNS2_13_must_destroyIS9_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFviEEC2IZN16TailscaleNetworkC1EPN6client6ObjectEEUliE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS9_PS1_EE5valueEvE4typeEPNSC_IXntsrNS2_13_must_destroyIS9_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null,a1:null}];
	tmp0[0].a0=Larg1.a0;
	tmp0[0].a1=Larg1.a1;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetworkC1EPN6client6ObjectEEUliE_JiEEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetworkC1EPN6client6ObjectEEUliE_JiEEEvPT_DpT0_(Larg0,Larg1){
	__ZZN16TailscaleNetworkC1EPN6client6ObjectEENKUliE_clEi(Larg0,Larg1);
}
function __ZZN16TailscaleNetworkC1EPN6client6ObjectEENKUliE_clEi(Larg0,Larg1){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0.call(null,Larg1);
	if((Larg1|0)===6)Larg0.a0.resolve.call(null);
}
function __ZN16TailscaleNetwork2upEv$presume(Larg0,Marg0){
	var tmp0=0,L$poptgepsqueezed15=null,tmp2=null,tmp3=null,tmp4=null,L$poptgepsqueezed16=null;
	tmp0=Larg0[Marg0].i8|0;
	L$poptgepsqueezed15=Larg0[Marg0].a6;
	tmp2={a0:nullArray,a0o:0};
	tmp3={a0:nullArray,a0o:0};
	if((tmp0&7)<2){
		L$poptgepsqueezed16=Larg0[Marg0].a5;
		if((tmp0&7)!==0){
			tmp4=__ZZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EEENK15promise_awaiter12await_resumeEv(L$poptgepsqueezed16);
			Larg0[Marg0].a4=tmp4;
			__ZZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed16);
			__ZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed15,tmp4.up());
			Larg0[Marg0].i8=2;
			__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_typeEE12from_addressB7v160000EPv(tmp2,Larg0,Marg0);
			__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_typeEEcvS_IvEB7v160000Ev(tmp3,tmp2);
			__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed15,tmp3);
		}else{
			__ZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed16,Larg0[Marg0].a3.a1);
			Larg0[Marg0].i8=1;
			__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_typeEE12from_addressB7v160000EPv(tmp2,Larg0,Marg0);
			__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_typeEEcvS_IvEB7v160000Ev(tmp3,tmp2);
			__ZZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed16,tmp3);
		}
	}else{
		L$poptgepsqueezed16=Larg0[Marg0].a7;
		if((tmp0&7)===2){
			__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed15);
			__ZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed16,Larg0[Marg0].a3.a2);
			Larg0[Marg0].i8=3;
			__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_typeEE12from_addressB7v160000EPv(tmp2,Larg0,Marg0);
			__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_typeEEcvS_IvEB7v160000Ev(tmp3,tmp2);
			__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed16,tmp3);
		}else{
			__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed16);
			Larg0[Marg0].a3.a0=Larg0[Marg0].a4;
			__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJR16TailscaleNetworkEE12promise_type12return_valueES3_(Larg0[Marg0].a2);
		}
	}
}
function __ZN16TailscaleNetwork2upEv$pdestroy(Larg0,Marg0){
	Larg0=Larg0[Marg0];
	var tmp0=0;
	tmp0=Larg0.i8|0;
	if(Larg0.a0!==null)if((tmp0&7)<2){
		if((tmp0&7)!==0)__ZZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0.a5);
	}else if((tmp0&7)===2)__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0.a6);
	else __ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0.a7);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEv(Larg0){
	var tmp0=null;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	return new Promise(_cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJR16TailscaleNetworkEE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(tmp0));
}
function __ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_typeEE12from_addressB7v160000EPv(Larg0,Larg1,Marg1){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_typeEEcvS_IvEB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_typeEE7addressB7v160000Ev(Larg1);
	tmp1=oSlot;
	__ZNSt16coroutine_handleIvE12from_addressB7v160000EPv(Larg0,tmp0,tmp1);
}
function __ZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EE(Larg0,Larg1){
	__ZZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EEEN15promise_awaiterC2EPNS3_IS2_EE(Larg0,Larg1);
}
function __ZZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(Larg0,Larg1){
	var tmp0=null,tmp1=null,tmp2=null,tmp3=null,tmp4=0;
	tmp0=new Uint8Array(1);
	tmp0[0]=0;
	Larg0.a2=tmp0;
	tmp1=Larg0.a0;
	tmp2={a0:null,a1:{a0:nullArray,a0o:0},a2:nullArray};
	tmp2.a0=Larg0;
	tmp3=Larg1.a0;
	tmp4=Larg1.a0o|0;
	tmp2.a1.a0=tmp3;
	tmp2.a1.a0o=tmp4;
	tmp2.a2=tmp0;
	tmp1.then(_cheerpCreate_ZN6client9_FunctionIFPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEPNS_9IPNetworkEEEC2IZZawISA_EDaRNS_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlSA_E_vEEOSG_(tmp2));
}
function __ZZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EEENK15promise_awaiter12await_resumeEv(Larg0){
	return Larg0.a1;
}
function __ZZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a2;
	if(tmp0!==nullArray||0!==0)tmp0[0]=1;
}
function __ZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EE(Larg0,Larg1){
	__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterC2EPNS3_IS2_EE(Larg0,Larg1);
}
function __ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(Larg0,Larg1){
	var tmp0=null,tmp1=null,tmp2=null,tmp3=null,tmp4=0;
	tmp0=new Uint8Array(1);
	tmp0[0]=0;
	Larg0.a2=tmp0;
	tmp1=Larg0.a0;
	tmp2={a0:null,a1:{a0:nullArray,a0o:0},a2:nullArray};
	tmp2.a0=Larg0;
	tmp3=Larg1.a0;
	tmp4=Larg1.a0o|0;
	tmp2.a1.a0=tmp3;
	tmp2.a1.a0o=tmp4;
	tmp2.a2=tmp0;
	tmp1.then(_cheerpCreate_ZN6client9_FunctionIFPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEES3_EEC2IZZawIS3_EDaRNS_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS3_E_vEEOSE_(tmp2));
}
function __ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a2;
	if(tmp0!==nullArray||0!==0)tmp0[0]=1;
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJR16TailscaleNetworkEE12promise_type12return_valueES3_(Larg0){
	Larg0.a0.call(null,null);
}
function _cheerpCreate_ZN6client9_FunctionIFPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEES3_EEC2IZZawIS3_EDaRNS_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS3_E_vEEOSE_(Larg0){
	return __ZN6cheerp8CallbackIRZZawIPN6client4_AnyEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_EEPNS2_13EventListenerEOS6_(Larg0);
}
function __ZN6cheerp8CallbackIRZZawIPN6client4_AnyEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_EEPNS2_13EventListenerEOS6_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZZawIPN6client4_AnyEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_EEDTclsr13ClosureHelperIS6_DTadsr6cheerp7utility16remove_referenceIS6_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS6_Efp_EEEOS6_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client4_AnyEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client4_AnyEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZZawIPN6client4_AnyEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_EEDTclsr13ClosureHelperIS6_DTadsr6cheerp7utility16remove_referenceIS6_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS6_Efp_EEEOS6_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZZawIPN6client4_AnyEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_MSC_KFvS4_EE12make_closureESD_(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client4_AnyEEEcvPNS1_13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFvPN6client4_AnyEEE14deleter_helperEPNS5_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFvPN6client4_AnyEEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFvPN6client4_AnyEEE14deleter_helperEPNS5_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp13ClosureHelperIRZZawIPN6client4_AnyEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_MSC_KFvS4_EE12make_closureESD_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client4_AnyEEEC2IRZZawIS3_EDaRNS1_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS3_E_EEOS9_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS9_PS4_EE5valueEvE4typeEPNSJ_IXntsrNS5_13_must_destroyIS9_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client4_AnyEEEC2IRZZawIS3_EDaRNS1_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS3_E_EEOS9_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS9_PS4_EE5valueEvE4typeEPNSJ_IXntsrNS5_13_must_destroyIS9_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=0,tmp2=null;
	tmp0=[{a0:null,a1:{a0:nullArray,a0o:0},a2:nullArray}];
	tmp0[0].a0=Larg1.a0;
	tmp2=Larg1.a1.a0;
	tmp1=Larg1.a1.a0o|0;
	tmp0[0].a1.a0=tmp2;
	tmp0[0].a1.a0o=tmp1;
	tmp2=Larg1.a2;
	tmp0[0].a2=tmp2;
	tmp2=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZZawIPN6client4_AnyEEDaRNS4_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS6_E_JS6_EEEvPS8_DpT0_,tmp0[0]);
	Larg0.a0=tmp2;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZZawIPN6client4_AnyEEDaRNS4_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS6_E_JS6_EEEvPS8_DpT0_(Larg0,Larg1){
	__ZZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEENKUlS2_E_clES2_(Larg0,Larg1);
}
function __ZZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEENKUlS2_E_clES2_(Larg0,Larg1){
	var tmp0=null;
	tmp0=Larg0.a2;
	if((tmp0[0]&1)===0){
		tmp0=Larg0.a0;
		tmp0.a1=Larg1;
		tmp0.a2=nullArray;
		__ZNKSt16coroutine_handleIvE6resumeB7v160000Ev(Larg0.a1);
	}
}
function __ZNKSt16coroutine_handleIvE6resumeB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	tmp0[tmp1].a0(tmp0,tmp1);
}
function __ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterC2EPNS3_IS2_EE(Larg0,Larg1){
	Larg0.a2=nullArray;
	Larg0.a0=Larg1;
}
function _cheerpCreate_ZN6client9_FunctionIFPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEPNS_9IPNetworkEEEC2IZZawISA_EDaRNS_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlSA_E_vEEOSG_(Larg0){
	return __ZN6cheerp8CallbackIRZZawIPN6client9IPNetworkEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_EEPNS2_13EventListenerEOS6_(Larg0);
}
function __ZN6cheerp8CallbackIRZZawIPN6client9IPNetworkEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_EEPNS2_13EventListenerEOS6_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZZawIPN6client9IPNetworkEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_EEDTclsr13ClosureHelperIS6_DTadsr6cheerp7utility16remove_referenceIS6_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS6_Efp_EEEOS6_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client9IPNetworkEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client9IPNetworkEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZZawIPN6client9IPNetworkEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_EEDTclsr13ClosureHelperIS6_DTadsr6cheerp7utility16remove_referenceIS6_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS6_Efp_EEEOS6_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZZawIPN6client9IPNetworkEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_MSC_KFvS4_EE12make_closureESD_(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client9IPNetworkEEEcvPNS1_13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFvPN6client9IPNetworkEEE14deleter_helperEPNS5_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFvPN6client9IPNetworkEEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFvPN6client9IPNetworkEEE14deleter_helperEPNS5_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp13ClosureHelperIRZZawIPN6client9IPNetworkEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_MSC_KFvS4_EE12make_closureESD_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client9IPNetworkEEEC2IRZZawIS3_EDaRNS1_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS3_E_EEOS9_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS9_PS4_EE5valueEvE4typeEPNSJ_IXntsrNS5_13_must_destroyIS9_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client9IPNetworkEEEC2IRZZawIS3_EDaRNS1_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS3_E_EEOS9_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS9_PS4_EE5valueEvE4typeEPNSJ_IXntsrNS5_13_must_destroyIS9_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=0,tmp2=null;
	tmp0=[{a0:null,a1:{a0:nullArray,a0o:0},a2:nullArray}];
	tmp0[0].a0=Larg1.a0;
	tmp2=Larg1.a1.a0;
	tmp1=Larg1.a1.a0o|0;
	tmp0[0].a1.a0=tmp2;
	tmp0[0].a1.a0o=tmp1;
	tmp2=Larg1.a2;
	tmp0[0].a2=tmp2;
	tmp2=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZZawIPN6client9IPNetworkEEDaRNS4_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS6_E_JS6_EEEvPS8_DpT0_,tmp0[0]);
	Larg0.a0=tmp2;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZZawIPN6client9IPNetworkEEDaRNS4_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS6_E_JS6_EEEvPS8_DpT0_(Larg0,Larg1){
	__ZZZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEENKUlS2_E_clES2_(Larg0,Larg1);
}
function __ZZZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEENKUlS2_E_clES2_(Larg0,Larg1){
	var tmp0=null;
	tmp0=Larg0.a2;
	if((tmp0[0]&1)===0){
		tmp0=Larg0.a0;
		tmp0.a1=Larg1;
		tmp0.a2=nullArray;
		__ZNKSt16coroutine_handleIvE6resumeB7v160000Ev(Larg0.a1);
	}
}
function __ZZawIPN6client9IPNetworkEEDaRNS0_7PromiseIT_EEEN15promise_awaiterC2EPNS3_IS2_EE(Larg0,Larg1){
	Larg0.a2=nullArray;
	Larg0.a0=Larg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_typeEE7addressB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	oSlot=tmp1;
	return tmp0;
}
function __ZNSt16coroutine_handleIvE12from_addressB7v160000EPv(Larg0,Larg1,Marg1){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
}
function __ZNSt16coroutine_handleIvEC2B7v160000Ev(Larg0){
	Larg0.a0=nullArray;
	Larg0.a0o=0;
}
function _cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJR16TailscaleNetworkEE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(Larg0){
	return __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0);
}
function __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISG_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISG_Efp_EEEOSG_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client8FunctionEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISG_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISG_Efp_EEEOSG_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSE_KFvSD_EE12make_closureESF_(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEEcvPNS1_13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFvPN6client8FunctionEEE14deleter_helperEPNS5_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEE14deleter_helperEPNS5_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSE_KFvSD_EE12make_closureESF_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISJ_PS4_EE5valueEvE4typeEPNSM_IXntsrNS5_13_must_destroyISJ_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISJ_PS4_EE5valueEvE4typeEPNSM_IXntsrNS5_13_must_destroyISJ_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSF_EEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSF_EEEvPT_DpT0_(Larg0,Larg1){
	__ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESB_(Larg0,Larg1);
}
function __ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJR16TailscaleNetworkEE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESB_(Larg0,Larg1){
	Larg0.a0.a0=Larg1;
}
function __ZN16TailscaleNetwork10UDPWrapperC2EPS_(Larg0,Larg1){
	__ZN16TailscaleNetwork10UDPWrapperC2EPN6client11IPUDPSocketE(Larg0,__ZN16TailscaleNetwork10UDPWrapper10makeSocketEPS_(Larg1));
}
function __ZN16TailscaleNetwork10UDPWrapper4bindEPS_j(Larg0,Larg1,Larg2){
	var tmp0=null,tmp1=null;
	if(((Larg0.a0.bind(Larg2))|0)!==0){
		tmp0=new Error("Cannot bind");
		Larg0.a1.reject.call(null,tmp0);
		__ZN16TailscaleNetwork10UDPWrapper5closeEPN6client5ErrorE(Larg0,tmp0);
	}else{
		tmp0=_cheerpCreate_ZN6client16UnderlyingSourceIPNS_10UDPMessageEEC2Ev();
		tmp1={a0:null,a1:null};
		tmp1.a0=Larg1;
		tmp1.a1=Larg0;
		tmp0.pull=__ZN6cheerp8CallbackIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlPN6client31ReadableStreamDefaultControllerIPNS4_10UDPMessageEEEE_EEPNS4_13EventListenerEOT_(tmp1);
		tmp1={a0:null};
		tmp1.a0=Larg0;
		tmp0.cancel=__ZN6cheerp8CallbackIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE_EEPN6client13EventListenerEOT_(tmp1);
		Larg0.a3=new ReadableStream(tmp0);
		tmp0=_cheerpCreate_ZN6client14UnderlyingSinkIPNS_10UDPMessageEEC2Ev();
		tmp1={a0:null,a1:null};
		tmp1.a0=Larg1;
		tmp1.a1=Larg0;
		tmp0.write=__ZN6cheerp8CallbackIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlPN6client10UDPMessageEPNS4_31WritableStreamDefaultControllerEE_EEPNS4_13EventListenerEOT_(tmp1);
		tmp1={a0:null};
		tmp1.a0=Larg0;
		tmp0.close=__ZN6cheerp8CallbackIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE0_EEPN6client13EventListenerEOT_(tmp1);
		tmp1={a0:null};
		tmp1.a0=Larg0;
		tmp0.abort=__ZN6cheerp8CallbackIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE1_EEPN6client13EventListenerEOT_(tmp1);
		Larg0.a4=new WritableStream(tmp0);
		tmp0="0.0.0.0";
		tmp1=Larg0.a1.resolve;
		tmp1.call(null,{readable :Larg0.a3, writable :Larg0.a4, localAddress :tmp0, localPort :Larg2});
	}
}
function __ZN16TailscaleNetwork10UDPWrapper5closeEPN6client5ErrorE(Larg0,Larg1){
	var tmp0=null;
	tmp0=Larg0.a0;
	if(tmp0!==null){
		tmp0.close();
		Larg0.i6=257;
		tmp0=Larg0.a2;
		if(Larg1!==null)tmp0.reject.call(null,Larg1);
		else tmp0.resolve.call(null);
		Larg0.a0.delete();
		Larg0.a0=null;
	}
}
function _cheerpCreate_ZN6client16UnderlyingSourceIPNS_10UDPMessageEEC2Ev(){
	return new Object();
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlPN6client31ReadableStreamDefaultControllerIPNS4_10UDPMessageEEEE_EEPNS4_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlPN6client31ReadableStreamDefaultControllerIPNS4_10UDPMessageEEEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISB_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISB_Efp_EEEOSB_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE_EEPN6client13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS5_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS5_Efp_EEEOS5_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvvEEcvPN6client13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvvEED2Ev(tmp0);
	return tmp1;
}
function _cheerpCreate_ZN6client14UnderlyingSinkIPNS_10UDPMessageEEC2Ev(){
	return new Object();
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlPN6client10UDPMessageEPNS4_31WritableStreamDefaultControllerEE_EEPNS4_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlPN6client10UDPMessageEPNS4_31WritableStreamDefaultControllerEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISA_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISA_Efp_EEEOSA_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client10UDPMessageEPNS1_31WritableStreamDefaultControllerEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client10UDPMessageEPNS1_31WritableStreamDefaultControllerEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE0_EEPN6client13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE0_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS5_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS5_Efp_EEEOS5_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvvEEcvPN6client13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvvEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE1_EEPN6client13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE1_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS5_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS5_Efp_EEEOS5_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvvEEcvPN6client13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvvEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE1_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS5_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS5_Efp_EEEOS5_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE1_MS4_KFvvEE12make_closureEOS4_(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvvEEcvPN6client13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFvvEE14deleter_helperEPNS2_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFvvEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFvvEE14deleter_helperEPNS2_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE1_MS4_KFvvEE12make_closureEOS4_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10UDPWrapper4bindEPS4_jEUlvE1_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS8_PS1_EE5valueEvE4typeEPNSB_IXntsrNS2_13_must_destroyIS8_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10UDPWrapper4bindEPS4_jEUlvE1_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS8_PS1_EE5valueEvE4typeEPNSB_IXntsrNS2_13_must_destroyIS8_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10UDPWrapper4bindEPS3_jEUlvE1_JEEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10UDPWrapper4bindEPS3_jEUlvE1_JEEEvPT_DpT0_(Larg0){
	__ZZN16TailscaleNetwork10UDPWrapper4bindEPS_jENKUlvE1_clEv(Larg0);
}
function __ZZN16TailscaleNetwork10UDPWrapper4bindEPS_jENKUlvE1_clEv(Larg0){
	__ZN16TailscaleNetwork10UDPWrapper9doCloseTxEv(Larg0.a0);
}
function __ZN16TailscaleNetwork10UDPWrapper9doCloseTxEv(Larg0){
	var Lmergedload=0;
	Lmergedload=Larg0.i6|0;
	Larg0.i6=Lmergedload&65280|1;
	if((Lmergedload&256)!==0)__ZN16TailscaleNetwork10UDPWrapper5closeEPN6client5ErrorE(Larg0,null);
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE0_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS5_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS5_Efp_EEEOS5_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE0_MS4_KFvvEE12make_closureEOS4_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE0_MS4_KFvvEE12make_closureEOS4_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10UDPWrapper4bindEPS4_jEUlvE0_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS8_PS1_EE5valueEvE4typeEPNSB_IXntsrNS2_13_must_destroyIS8_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10UDPWrapper4bindEPS4_jEUlvE0_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS8_PS1_EE5valueEvE4typeEPNSB_IXntsrNS2_13_must_destroyIS8_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10UDPWrapper4bindEPS3_jEUlvE0_JEEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10UDPWrapper4bindEPS3_jEUlvE0_JEEEvPT_DpT0_(Larg0){
	__ZZN16TailscaleNetwork10UDPWrapper4bindEPS_jENKUlvE0_clEv(Larg0);
}
function __ZZN16TailscaleNetwork10UDPWrapper4bindEPS_jENKUlvE0_clEv(Larg0){
	__ZN16TailscaleNetwork10UDPWrapper9doCloseTxEv(Larg0.a0);
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlPN6client10UDPMessageEPNS4_31WritableStreamDefaultControllerEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISA_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISA_Efp_EEEOSA_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlPN6client10UDPMessageEPNS4_31WritableStreamDefaultControllerEE_MS9_KFvS6_S8_EE12make_closureEOS9_(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client10UDPMessageEPNS1_31WritableStreamDefaultControllerEEEcvPNS1_13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFvPN6client10UDPMessageEPNS1_31WritableStreamDefaultControllerEEE14deleter_helperEPNS7_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFvPN6client10UDPMessageEPNS1_31WritableStreamDefaultControllerEEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFvPN6client10UDPMessageEPNS1_31WritableStreamDefaultControllerEEE14deleter_helperEPNS7_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlPN6client10UDPMessageEPNS4_31WritableStreamDefaultControllerEE_MS9_KFvS6_S8_EE12make_closureEOS9_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client10UDPMessageEPNS1_31WritableStreamDefaultControllerEEEC2IZN16TailscaleNetwork10UDPWrapper4bindEPS9_jEUlS3_S5_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISD_PS6_EE5valueEvE4typeEPNSG_IXntsrNS7_13_must_destroyISD_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client10UDPMessageEPNS1_31WritableStreamDefaultControllerEEEC2IZN16TailscaleNetwork10UDPWrapper4bindEPS9_jEUlS3_S5_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISD_PS6_EE5valueEvE4typeEPNSG_IXntsrNS7_13_must_destroyISD_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null,a1:null}];
	tmp0[0].a0=Larg1.a0;
	tmp0[0].a1=Larg1.a1;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10UDPWrapper4bindEPS3_jEUlPN6client10UDPMessageEPNS6_31WritableStreamDefaultControllerEE_JS8_SA_EEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10UDPWrapper4bindEPS3_jEUlPN6client10UDPMessageEPNS6_31WritableStreamDefaultControllerEE_JS8_SA_EEEvPT_DpT0_(Larg0,Larg1,Larg2){
	__ZZN16TailscaleNetwork10UDPWrapper4bindEPS_jENKUlPN6client10UDPMessageEPNS2_31WritableStreamDefaultControllerEE_clES4_S6_(Larg0,Larg1,Larg2);
}
function __ZZN16TailscaleNetwork10UDPWrapper4bindEPS_jENKUlPN6client10UDPMessageEPNS2_31WritableStreamDefaultControllerEE_clES4_S6_(Larg0,Larg1,Larg2){
	__ZN16TailscaleNetwork10UDPWrapper5writeEPS_PN6client10UDPMessageEPNS2_31WritableStreamDefaultControllerE(Larg0.a1,Larg0.a0,Larg1,Larg2);
}
function __ZN16TailscaleNetwork10UDPWrapper5writeEPS_PN6client10UDPMessageEPNS2_31WritableStreamDefaultControllerE(Larg0,Larg1,Larg2,Larg3){
	var tmp0=null,tmp1=null,tmp2=null,tmp3=0;
	tmp0=Larg0.a0;
	tmp1=Larg2.data;
	tmp2=Larg1.a0;
	tmp3=tmp2.parseIP(Larg2.remoteAddress);
	if(((tmp0.sendto(tmp1,tmp3,Larg2.remotePort))|0)<0){
		Larg3.error("Error on write");
		__ZN16TailscaleNetwork10UDPWrapper5closeEPN6client5ErrorE(Larg0,new Error("Error on write"));
	}
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS5_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS5_Efp_EEEOS5_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE_MS4_KFvvEE12make_closureEOS4_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlvE_MS4_KFvvEE12make_closureEOS4_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10UDPWrapper4bindEPS4_jEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS8_PS1_EE5valueEvE4typeEPNSB_IXntsrNS2_13_must_destroyIS8_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10UDPWrapper4bindEPS4_jEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS8_PS1_EE5valueEvE4typeEPNSB_IXntsrNS2_13_must_destroyIS8_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10UDPWrapper4bindEPS3_jEUlvE_JEEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10UDPWrapper4bindEPS3_jEUlvE_JEEEvPT_DpT0_(Larg0){
	__ZZN16TailscaleNetwork10UDPWrapper4bindEPS_jENKUlvE_clEv(Larg0);
}
function __ZZN16TailscaleNetwork10UDPWrapper4bindEPS_jENKUlvE_clEv(Larg0){
	__ZN16TailscaleNetwork10UDPWrapper9doCloseRxEv(Larg0.a0);
}
function __ZN16TailscaleNetwork10UDPWrapper9doCloseRxEv(Larg0){
	var Lmergedload=0;
	Lmergedload=Larg0.i6|0;
	Larg0.i6=Lmergedload&255|256;
	if((Lmergedload&1)!==0)__ZN16TailscaleNetwork10UDPWrapper5closeEPN6client5ErrorE(Larg0,null);
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlPN6client31ReadableStreamDefaultControllerIPNS4_10UDPMessageEEEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISB_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISB_Efp_EEEOSB_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlPN6client31ReadableStreamDefaultControllerIPNS4_10UDPMessageEEEE_MSA_KFPNS4_7PromiseIPNS4_4_AnyEEES9_EE12make_closureEOSA_(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEEcvPNS1_13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEE14deleter_helperEPNSD_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEE14deleter_helperEPNSD_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10UDPWrapper4bindEPS1_jEUlPN6client31ReadableStreamDefaultControllerIPNS4_10UDPMessageEEEE_MSA_KFPNS4_7PromiseIPNS4_4_AnyEEES9_EE12make_closureEOSA_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEEC2IZN16TailscaleNetwork10UDPWrapper4bindEPSF_jEUlSB_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISJ_PSC_EE5valueEvE4typeEPNSM_IXntsrNSD_13_must_destroyISJ_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEEC2IZN16TailscaleNetwork10UDPWrapper4bindEPSF_jEUlSB_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISJ_PSC_EE5valueEvE4typeEPNSM_IXntsrNSD_13_must_destroyISJ_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null,a1:null}];
	tmp0[0].a0=Larg1.a0;
	tmp0[0].a1=Larg1.a1;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN16TailscaleNetwork10UDPWrapper4bindEPS9_jEUlPNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEE_JSG_EEES6_PT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN16TailscaleNetwork10UDPWrapper4bindEPS9_jEUlPNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEE_JSG_EEES6_PT_DpT0_(Larg0,Larg1){
	return __ZZN16TailscaleNetwork10UDPWrapper4bindEPS_jENKUlPN6client31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEEE_clES7_(Larg0,Larg1);
}
function __ZZN16TailscaleNetwork10UDPWrapper4bindEPS_jENKUlPN6client31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEEE_clES7_(Larg0,Larg1){
	return __ZN16TailscaleNetwork10UDPWrapper4readEPS_PN6client31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEE(Larg0.a1,Larg0.a0,Larg1);
}
function __ZN16TailscaleNetwork10UDPWrapper4readEPS_PN6client31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEE(Larg0,Larg1,Larg2){
	var tmp0=null,tmp1=null,tmp2=null,L$poptgepsqueezed16=null,tmp4=null,tmp5=0,tmp6=null;
	tmp1=new constructor__ZN16TailscaleNetwork10UDPWrapper4readEPS_PN6client31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEE$pFrame().a;
	tmp2=tmp1[0];
	tmp2.a0=__ZN16TailscaleNetwork10UDPWrapper4readEPS_PN6client31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEE$presume;
	tmp2.a1=__ZN16TailscaleNetwork10UDPWrapper4readEPS_PN6client31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEE$pdestroy;
	tmp2.a7=Larg2;
	tmp2.a6=Larg1;
	tmp2.a5=Larg0;
	L$poptgepsqueezed16=tmp2.a2;
	tmp0=__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_10UDPMessageEEEEE12promise_type17get_return_objectEv(L$poptgepsqueezed16);
	tmp2.a4=new Uint8Array(1500);
	tmp2.a3=_cheerpCreate_ZN6client10IPAddrInfoC2Ev();
	tmp4=tmp2.a5.a0;
	tmp5=tmp2.a4.length;
	tmp5=tmp4.recv(tmp2.a4,0,tmp5,tmp2.a3);
	tmp2.i8=tmp5;
	if((tmp5|0)===-11){
		L$poptgepsqueezed16=tmp2.a9;
		__ZawIiEDaRN6client7PromiseIT_EE(L$poptgepsqueezed16,tmp2.a5.a0.waitIncoming());
		tmp2.i10=1;
		tmp2={a0:nullArray,a0o:0};
		__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEE12promise_typeEE12from_addressB7v160000EPv(tmp2,tmp1,0);
		tmp1={a0:nullArray,a0o:0};
		__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEE12promise_typeEEcvS_IvEB7v160000Ev(tmp1,tmp2);
		__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed16,tmp1);
	}else{
		tmp1=tmp2.a7;
		if((tmp5|0)<1){
			tmp4=tmp2.a5;
			tmp6="Error on read";
			tmp1.error(tmp6);
			tmp1="Error on read";
			__ZN16TailscaleNetwork10UDPWrapper5closeEPN6client5ErrorE(tmp4,new Error(tmp1));
			__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_10UDPMessageEEEEE12promise_type12return_valueES3_(L$poptgepsqueezed16);
		}else{
			tmp4=tmp2.a6;
			tmp6=_cheerpCreate_ZN6client10UDPMessageC2Ev();
			tmp6.data=tmp2.a4.subarray(0,(+(tmp5|0)));
			tmp4=tmp4.a0;
			tmp6.remoteAddress=tmp4.dumpIP(tmp2.a3.addr);
			tmp6.remotePort=tmp2.a3.port;
			tmp1.enqueue(tmp6);
			__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_10UDPMessageEEEEE12promise_type12return_valueES3_(L$poptgepsqueezed16);
		}
	}
	return tmp0;
}
function __ZN16TailscaleNetwork10UDPWrapper4readEPS_PN6client31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEE$presume(Larg0,Marg0){
	var L$poptgepsqueezed16=null,tmp1=0,L$poptgepsqueezed15=null,tmp3=null,tmp4=null,tmp5=null;
	L$poptgepsqueezed16=Larg0[Marg0].a9;
	a:{
		b:{
			if((Larg0[Marg0].i10&3)!==0){
				tmp1=__ZZawIiEDaRN6client7PromiseIT_EEENK15promise_awaiter12await_resumeEv(L$poptgepsqueezed16)|0;
				__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed16);
				if((tmp1|0)!==0)break b;
				tmp3=Larg0[Marg0].a3;
				tmp4=Larg0[Marg0].a4;
			}else{
				tmp4=new Uint8Array(1500);
				Larg0[Marg0].a4=tmp4;
				tmp3=_cheerpCreate_ZN6client10IPAddrInfoC2Ev();
				Larg0[Marg0].a3=tmp3;
			}
			tmp5=Larg0[Marg0].a5;
			L$poptgepsqueezed15=tmp5.a0;
			tmp1=L$poptgepsqueezed15.recv(tmp4,0,tmp4.length,tmp3);
			Larg0[Marg0].i8=tmp1;
			if((tmp1|0)===-11){
				__ZawIiEDaRN6client7PromiseIT_EE(L$poptgepsqueezed16,tmp5.a0.waitIncoming());
				Larg0[Marg0].i10=1;
				tmp3={a0:nullArray,a0o:0};
				__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEE12promise_typeEE12from_addressB7v160000EPv(tmp3,Larg0,Marg0);
				tmp4={a0:nullArray,a0o:0};
				__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEE12promise_typeEEcvS_IvEB7v160000Ev(tmp4,tmp3);
				__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed16,tmp4);
				break a;
			}
		}
		L$poptgepsqueezed16=Larg0[Marg0].a7;
		L$poptgepsqueezed15=Larg0[Marg0].a2;
		if((tmp1|0)<1){
			tmp3=Larg0[Marg0].a5;
			tmp4="Error on read";
			L$poptgepsqueezed16.error(tmp4);
			L$poptgepsqueezed16="Error on read";
			__ZN16TailscaleNetwork10UDPWrapper5closeEPN6client5ErrorE(tmp3,new Error(L$poptgepsqueezed16));
			__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_10UDPMessageEEEEE12promise_type12return_valueES3_(L$poptgepsqueezed15);
		}else{
			tmp3=Larg0[Marg0].a6;
			tmp5=_cheerpCreate_ZN6client10UDPMessageC2Ev();
			tmp5.data=Larg0[Marg0].a4.subarray(0,(+(tmp1|0)));
			tmp3=tmp3.a0;
			tmp4=Larg0[Marg0].a3;
			tmp5.remoteAddress=tmp3.dumpIP(tmp4.addr);
			tmp5.remotePort=tmp4.port;
			L$poptgepsqueezed16.enqueue(tmp5);
			__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_10UDPMessageEEEEE12promise_type12return_valueES3_(L$poptgepsqueezed15);
		}
	}
}
function __ZN16TailscaleNetwork10UDPWrapper4readEPS_PN6client31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEE$pdestroy(Larg0,Marg0){
	Larg0=Larg0[Marg0];
	var tmp0=0;
	tmp0=Larg0.i10|0;
	if(Larg0.a0!==null)if((tmp0&3)!==0)__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0.a9);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_10UDPMessageEEEEE12promise_type17get_return_objectEv(Larg0){
	var tmp0=null;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	return new Promise(_cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRN16TailscaleNetwork10UDPWrapperEPSM_PNS_31ReadableStreamDefaultControllerIPNS_10UDPMessageEEEEE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(tmp0));
}
function __ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEE12promise_typeEE12from_addressB7v160000EPv(Larg0,Larg1,Marg1){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEE12promise_typeEEcvS_IvEB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEE12promise_typeEE7addressB7v160000Ev(Larg1);
	tmp1=oSlot;
	__ZNSt16coroutine_handleIvE12from_addressB7v160000EPv(Larg0,tmp0,tmp1);
}
function _cheerpCreate_ZN6client10IPAddrInfoC2Ev(){
	return new Object();
}
function __ZawIiEDaRN6client7PromiseIT_EE(Larg0,Larg1){
	__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiterC2EPNS1_IiEE(Larg0,Larg1);
}
function __ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(Larg0,Larg1){
	var tmp0=null,tmp1=null,tmp2=null,tmp3=null,tmp4=0;
	tmp0=new Uint8Array(1);
	tmp0[0]=0;
	Larg0.a2=tmp0;
	tmp1=Larg0.a0;
	tmp2={a0:null,a1:{a0:nullArray,a0o:0},a2:nullArray};
	tmp2.a0=Larg0;
	tmp3=Larg1.a0;
	tmp4=Larg1.a0o|0;
	tmp2.a1.a0=tmp3;
	tmp2.a1.a0o=tmp4;
	tmp2.a2=tmp0;
	tmp1.then(_cheerpCreate_ZN6client9_FunctionIFPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEiEEC2IZZawIiEDaRNS_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUliE_vEEOSE_(tmp2));
}
function __ZZawIiEDaRN6client7PromiseIT_EEENK15promise_awaiter12await_resumeEv(Larg0){
	return Larg0.i1|0;
}
function __ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a2;
	if(tmp0!==nullArray||0!==0)tmp0[0]=1;
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_10UDPMessageEEEEE12promise_type12return_valueES3_(Larg0){
	Larg0.a0.call(null,null);
}
function _cheerpCreate_ZN6client10UDPMessageC2Ev(){
	return new Object();
}
function _cheerpCreate_ZN6client9_FunctionIFPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEiEEC2IZZawIiEDaRNS_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUliE_vEEOSE_(Larg0){
	return __ZN6cheerp8CallbackIRZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUliE_EEPNS2_13EventListenerEOS4_(Larg0);
}
function __ZN6cheerp8CallbackIRZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUliE_EEPNS2_13EventListenerEOS4_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUliE_EEDTclsr13ClosureHelperIS4_DTadsr6cheerp7utility16remove_referenceIS4_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS4_Efp_EEEOS4_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFviEEcvPN6client13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFviEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUliE_EEDTclsr13ClosureHelperIS4_DTadsr6cheerp7utility16remove_referenceIS4_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS4_Efp_EEEOS4_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUliE_MSA_KFviEE12make_closureESB_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIRZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUliE_MSA_KFviEE12make_closureESB_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFviEEC2IRZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUliE_EEOS7_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS7_PS1_EE5valueEvE4typeEPNSH_IXntsrNS2_13_must_destroyIS7_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFviEEC2IRZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUliE_EEOS7_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS7_PS1_EE5valueEvE4typeEPNSH_IXntsrNS2_13_must_destroyIS7_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=0,tmp2=null;
	tmp0=[{a0:null,a1:{a0:nullArray,a0o:0},a2:nullArray}];
	tmp0[0].a0=Larg1.a0;
	tmp2=Larg1.a1.a0;
	tmp1=Larg1.a1.a0o|0;
	tmp0[0].a1.a0=tmp2;
	tmp0[0].a1.a0o=tmp1;
	tmp2=Larg1.a2;
	tmp0[0].a2=tmp2;
	tmp2=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUliE_JiEEEvPS6_DpT0_,tmp0[0]);
	Larg0.a0=tmp2;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUliE_JiEEEvPS6_DpT0_(Larg0,Larg1){
	__ZZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEENKUliE_clEi(Larg0,Larg1);
}
function __ZZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEENKUliE_clEi(Larg0,Larg1){
	var tmp0=null;
	tmp0=Larg0.a2;
	if((tmp0[0]&1)===0){
		tmp0=Larg0.a0;
		tmp0.i1=Larg1;
		tmp0.a2=nullArray;
		__ZNKSt16coroutine_handleIvE6resumeB7v160000Ev(Larg0.a1);
	}
}
function __ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiterC2EPNS1_IiEE(Larg0,Larg1){
	Larg0.a2=nullArray;
	Larg0.a0=Larg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEE12promise_typeEE7addressB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	oSlot=tmp1;
	return tmp0;
}
function _cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRN16TailscaleNetwork10UDPWrapperEPSM_PNS_31ReadableStreamDefaultControllerIPNS_10UDPMessageEEEEE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(Larg0){
	return __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS8_PNS2_31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0);
}
function __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS8_PNS2_31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS8_PNS2_31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISN_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISN_Efp_EEEOSN_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client8FunctionEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS8_PNS2_31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISN_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISN_Efp_EEEOSN_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS8_PNS2_31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSL_KFvSK_EE12make_closureESM_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS8_PNS2_31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSL_KFvSK_EE12make_closureESM_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPSD_PNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISQ_PS4_EE5valueEvE4typeEPNST_IXntsrNS5_13_must_destroyISQ_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPSD_PNS1_31ReadableStreamDefaultControllerIPNS1_10UDPMessageEEEEE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISQ_PS4_EE5valueEvE4typeEPNST_IXntsrNS5_13_must_destroyISQ_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPSA_PNS4_31ReadableStreamDefaultControllerIPNS4_10UDPMessageEEEEE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSM_EEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPSA_PNS4_31ReadableStreamDefaultControllerIPNS4_10UDPMessageEEEEE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSM_EEEvPT_DpT0_(Larg0,Larg1){
	__ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_10UDPMessageEEEEE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESI_(Larg0,Larg1);
}
function __ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10UDPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_10UDPMessageEEEEE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESI_(Larg0,Larg1){
	Larg0.a0.a0=Larg1;
}
function __ZN16TailscaleNetwork10UDPWrapper10makeSocketEPS_(Larg0){
	return new Larg0.a0.udpSocket();
}
function __ZN16TailscaleNetwork10UDPWrapperC2EPN6client11IPUDPSocketE(Larg0,Larg1){
	var tmp0=null;
	Larg0.a0=Larg1;
	Larg0.a1=__ZN6client20PromiseWithResolversIPNS_6ObjectEE6createEv();
	Larg0.a2=__ZN6client20PromiseWithResolversIPNS_4_AnyEE6createEv();
	Larg0.a3=null;
	Larg0.a4=null;
	Larg0.i6=0;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	Larg0.a5=__ZN6cheerp8CallbackIZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEEUlvE_EEPNS3_13EventListenerEOT_(tmp0);
}
function __ZN6client20PromiseWithResolversIPNS_6ObjectEE6createEv(){
	return Promise.withResolvers();
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEEUlvE_EEPNS3_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS7_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS7_Efp_EEEOS7_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS7_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS7_Efp_EEEOS7_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEEUlvE_MS6_KFPNS3_7PromiseIPNS3_4_AnyEEEvEE12make_closureEOS6_(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEEcvPNS1_13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEE14deleter_helperEPNS8_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEE14deleter_helperEPNS8_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEEUlvE_MS6_KFPNS3_7PromiseIPNS3_4_AnyEEEvEE12make_closureEOS6_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEEC2IZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISF_PS7_EE5valueEvE4typeEPNSI_IXntsrNS8_13_must_destroyISF_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEEC2IZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISF_PS7_EE5valueEvE4typeEPNSI_IXntsrNS8_13_must_destroyISF_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_JEEES6_PT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_JEEES6_PT_DpT0_(Larg0){
	return __ZZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEENKUlvE_clEv(Larg0);
}
function __ZZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEENKUlvE_clEv(Larg0){
	var L$poptgepsqueezed8=null,tmp1=null,tmp2=null,tmp3=null;
	tmp1=Larg0.a0;
	tmp2=new constructor__ZZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEENKUlvE_clEv$pFrame().a;
	tmp3=tmp2[0];
	tmp3.a0=__ZZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEENKUlvE_clEv$presume;
	tmp3.a1=__ZZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEENKUlvE_clEv$pdestroy;
	tmp3.a3=tmp1;
	tmp1=__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS0_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEv(tmp3.a2);
	L$poptgepsqueezed8=tmp3.a4;
	__ZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed8,tmp3.a3.a3.cancel());
	tmp3.i6=1;
	tmp3={a0:nullArray,a0o:0};
	__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EE12promise_typeEE12from_addressB7v160000EPv(tmp3,tmp2,0);
	tmp2={a0:nullArray,a0o:0};
	__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(tmp2,tmp3);
	__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed8,tmp2);
	return tmp1;
}
function __ZZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEENKUlvE_clEv$presume(Larg0,Marg0){
	var tmp0=0,L$poptgepsqueezed7=null,L$poptgepsqueezed8=null,tmp3=null,tmp4=null;
	tmp0=Larg0[Marg0].i6|0;
	L$poptgepsqueezed7=Larg0[Marg0].a5;
	if(tmp0<<30>-1073741824){
		L$poptgepsqueezed8=Larg0[Marg0].a4;
		tmp3={a0:nullArray,a0o:0};
		tmp4={a0:nullArray,a0o:0};
		if((tmp0&3)!==0){
			__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed8);
			__ZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed7,Larg0[Marg0].a3.a4.abort());
			Larg0[Marg0].i6=2;
			__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EE12promise_typeEE12from_addressB7v160000EPv(tmp3,Larg0,Marg0);
			__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(tmp4,tmp3);
			__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed7,tmp4);
		}else{
			__ZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed8,Larg0[Marg0].a3.a3.cancel());
			Larg0[Marg0].i6=1;
			__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EE12promise_typeEE12from_addressB7v160000EPv(tmp3,Larg0,Marg0);
			__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(tmp4,tmp3);
			__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed8,tmp4);
		}
	}else{
		__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed7);
		__ZN16TailscaleNetwork10UDPWrapper5closeEPN6client5ErrorE(Larg0[Marg0].a3,null);
		__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS0_11IPUDPSocketEEUlvE_EE12promise_type12return_valueES3_(Larg0[Marg0].a2);
	}
}
function __ZZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEENKUlvE_clEv$pdestroy(Larg0,Marg0){
	Larg0=Larg0[Marg0];
	var tmp0=0,L$psink=null;
	tmp0=Larg0.i6|0;
	a:if(Larg0.a0!==null){
		if(tmp0<<30>-1073741824){
			if((tmp0&3)===0)break a;
			L$psink=Larg0.a4;
		}else{
			L$psink=Larg0.a5;
		}
		__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(L$psink);
	}
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS0_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEv(Larg0){
	var tmp0=null;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	return new Promise(_cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(tmp0));
}
function __ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EE12promise_typeEE12from_addressB7v160000EPv(Larg0,Larg1,Marg1){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EE12promise_typeEE7addressB7v160000Ev(Larg1);
	tmp1=oSlot;
	__ZNSt16coroutine_handleIvE12from_addressB7v160000EPv(Larg0,tmp0,tmp1);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS0_11IPUDPSocketEEUlvE_EE12promise_type12return_valueES3_(Larg0){
	Larg0.a0.call(null,null);
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EE12promise_typeEE7addressB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	oSlot=tmp1;
	return tmp0;
}
function _cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(Larg0){
	return __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS2_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0);
}
function __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS2_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS2_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISL_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISL_Efp_EEEOSL_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client8FunctionEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS2_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISL_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISL_Efp_EEEOSL_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS2_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSJ_KFvSI_EE12make_closureESK_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS2_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSJ_KFvSI_EE12make_closureESK_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISO_PS4_EE5valueEvE4typeEPNSR_IXntsrNS5_13_must_destroyISO_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS1_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISO_PS4_EE5valueEvE4typeEPNSR_IXntsrNS5_13_must_destroyISO_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS4_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSK_EEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS4_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSK_EEEvPT_DpT0_(Larg0,Larg1){
	__ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS0_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESG_(Larg0,Larg1);
}
function __ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN16TailscaleNetwork10UDPWrapperC1EPNS0_11IPUDPSocketEEUlvE_EE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESG_(Larg0,Larg1){
	Larg0.a0.a0=Larg1;
}
function __ZN16TailscaleNetwork10TCPWrapperC2EPS_(Larg0,Larg1){
	__ZN16TailscaleNetwork10TCPWrapperC2EPN6client11IPTCPSocketE(Larg0,__ZN16TailscaleNetwork10TCPWrapper10makeSocketEPS_(Larg1));
}
function __ZN16TailscaleNetwork10TCPWrapper6listenEPS_PN6client6StringEj(Larg0,Larg1,Larg2,Larg3){
	var tmp0=null,tmp1=null;
	if(((Larg0.a0.bind(Larg3))|0)!==0){
		tmp0=new Error("Cannot bind");
		Larg0.a1.reject.call(null,tmp0);
		__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(Larg0,tmp0);
	}else{
		Larg0.a0.listen();
		tmp0=_cheerpCreate_ZN6client16UnderlyingSourceIPNS_6ObjectEEC2Ev();
		tmp1={a0:null,a1:null,i2:0};
		tmp1.a0=Larg0;
		tmp1.a1=Larg1;
		tmp1.i2=Larg3;
		tmp0.pull=__ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper6listenEPS1_PN6client6StringEjEUlPNS4_31ReadableStreamDefaultControllerIPNS4_6ObjectEEEE_EEPNS4_13EventListenerEOT_(tmp1);
		tmp1={a0:null};
		tmp1.a0=Larg0;
		tmp0.cancel=__ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper6listenEPS1_PN6client6StringEjEUlvE_EEPNS4_13EventListenerEOT_(tmp1);
		Larg0.a3=new ReadableStream(tmp0);
		tmp0=Larg0.a1.resolve;
		tmp0.call(null,{readable :Larg0.a3, localAddress :Larg2, localPort :Larg3});
	}
}
function __ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(Larg0,Larg1){
	var tmp0=null;
	tmp0=Larg0.a0;
	if(tmp0!==null){
		tmp0.close();
		Larg0.i6=257;
		tmp0=Larg0.a2;
		if(Larg1!==null)tmp0.reject.call(null,Larg1);
		else tmp0.resolve.call(null);
		Larg0.a0.delete();
		Larg0.a0=null;
	}
}
function _cheerpCreate_ZN6client16UnderlyingSourceIPNS_6ObjectEEC2Ev(){
	return new Object();
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper6listenEPS1_PN6client6StringEjEUlPNS4_31ReadableStreamDefaultControllerIPNS4_6ObjectEEEE_EEPNS4_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper6listenEPS1_PN6client6StringEjEUlPNS4_31ReadableStreamDefaultControllerIPNS4_6ObjectEEEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISD_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISD_Efp_EEEOSD_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper6listenEPS1_PN6client6StringEjEUlvE_EEPNS4_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper6listenEPS1_PN6client6StringEjEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS8_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS8_Efp_EEEOS8_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvvEEcvPN6client13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvvEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper6listenEPS1_PN6client6StringEjEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS8_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS8_Efp_EEEOS8_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper6listenEPS1_PN6client6StringEjEUlvE_MS7_KFvvEE12make_closureEOS7_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper6listenEPS1_PN6client6StringEjEUlvE_MS7_KFvvEE12make_closureEOS7_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10TCPWrapper6listenEPS4_PN6client6StringEjEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISB_PS1_EE5valueEvE4typeEPNSE_IXntsrNS2_13_must_destroyISB_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10TCPWrapper6listenEPS4_PN6client6StringEjEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISB_PS1_EE5valueEvE4typeEPNSE_IXntsrNS2_13_must_destroyISB_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10TCPWrapper6listenEPS3_PN6client6StringEjEUlvE_JEEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10TCPWrapper6listenEPS3_PN6client6StringEjEUlvE_JEEEvPT_DpT0_(Larg0){
	__ZZN16TailscaleNetwork10TCPWrapper6listenEPS_PN6client6StringEjENKUlvE_clEv(Larg0);
}
function __ZZN16TailscaleNetwork10TCPWrapper6listenEPS_PN6client6StringEjENKUlvE_clEv(Larg0){
	__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(Larg0.a0,null);
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper6listenEPS1_PN6client6StringEjEUlPNS4_31ReadableStreamDefaultControllerIPNS4_6ObjectEEEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISD_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISD_Efp_EEEOSD_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper6listenEPS1_PN6client6StringEjEUlPNS4_31ReadableStreamDefaultControllerIPNS4_6ObjectEEEE_MSC_KFPNS4_7PromiseIPNS4_4_AnyEEESB_EE12make_closureEOSC_(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEEEcvPNS1_13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEEE14deleter_helperEPNSD_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEEE14deleter_helperEPNSD_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper6listenEPS1_PN6client6StringEjEUlPNS4_31ReadableStreamDefaultControllerIPNS4_6ObjectEEEE_MSC_KFPNS4_7PromiseIPNS4_4_AnyEEESB_EE12make_closureEOSC_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEEEC2IZN16TailscaleNetwork10TCPWrapper6listenEPSF_PNS1_6StringEjEUlSB_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISL_PSC_EE5valueEvE4typeEPNSO_IXntsrNSD_13_must_destroyISL_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEEEC2IZN16TailscaleNetwork10TCPWrapper6listenEPSF_PNS1_6StringEjEUlSB_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISL_PSC_EE5valueEvE4typeEPNSO_IXntsrNSD_13_must_destroyISL_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null,a1:null,i2:0}];
	tmp0[0].a0=Larg1.a0;
	tmp0[0].a1=Larg1.a1;
	tmp0[0].i2=Larg1.i2|0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN16TailscaleNetwork10TCPWrapper6listenEPS9_PNS1_6StringEjEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_JSI_EEES6_PT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN16TailscaleNetwork10TCPWrapper6listenEPS9_PNS1_6StringEjEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_JSI_EEES6_PT_DpT0_(Larg0,Larg1){
	return __ZZN16TailscaleNetwork10TCPWrapper6listenEPS_PN6client6StringEjENKUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_clES9_(Larg0,Larg1);
}
function __ZZN16TailscaleNetwork10TCPWrapper6listenEPS_PN6client6StringEjENKUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_clES9_(Larg0,Larg1){
	return __ZN16TailscaleNetwork10TCPWrapper6acceptEPS_PN6client31ReadableStreamDefaultControllerIPNS2_6ObjectEEEi(Larg0.a0,Larg0.a1,Larg1,Larg0.i2|0);
}
function __ZN16TailscaleNetwork10TCPWrapper6acceptEPS_PN6client31ReadableStreamDefaultControllerIPNS2_6ObjectEEEi(Larg0,Larg1,Larg2,Larg3){
	var tmp0=null,tmp1=0,tmp2=null,tmp3=null,tmp4=null,L$poptgepsqueezed20=null,tmp6=null;
	tmp3=new constructor__ZN16TailscaleNetwork10TCPWrapper6acceptEPS_PN6client31ReadableStreamDefaultControllerIPNS2_6ObjectEEEi$pFrame().a;
	tmp4=tmp3[0];
	tmp4.a0=__ZN16TailscaleNetwork10TCPWrapper6acceptEPS_PN6client31ReadableStreamDefaultControllerIPNS2_6ObjectEEEi$presume;
	tmp4.a1=__ZN16TailscaleNetwork10TCPWrapper6acceptEPS_PN6client31ReadableStreamDefaultControllerIPNS2_6ObjectEEEi$pdestroy;
	tmp4.i6=Larg3;
	tmp4.a5=Larg2;
	tmp4.a4=Larg1;
	tmp4.a3=Larg0;
	L$poptgepsqueezed20=tmp4.a2;
	tmp0=__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEiEE12promise_type17get_return_objectEv(L$poptgepsqueezed20);
	tmp6=tmp4.a3.a0.accept();
	if(tmp6!==null){
		tmp1=tmp4.i6|0;
		tmp3=tmp4.a5;
		tmp4=tmp4.a4;
		tmp2={a0:null,a1:null,a2:null,a3:null,a4:null,a5:null,i6:0};
		__ZN16TailscaleNetwork10TCPWrapperC2EPN6client11IPTCPSocketE(tmp2,tmp6.socket);
		tmp4=tmp4.a0;
		tmp4=tmp4.dumpIP(tmp6.addr);
		__ZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjj(tmp2,tmp4,tmp6.port,tmp1);
		tmp4=tmp2.a1.promise;
		tmp6=tmp2.a2.promise;
		tmp3.enqueue({opened :tmp4, closed :tmp6, close :tmp2.a5});
		__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEiEE12promise_type12return_valueES3_(L$poptgepsqueezed20);
	}else{
		L$poptgepsqueezed20=tmp4.a8;
		__ZawIiEDaRN6client7PromiseIT_EE(L$poptgepsqueezed20,tmp4.a3.a0.waitIncoming());
		tmp4.i9=1;
		tmp4={a0:nullArray,a0o:0};
		__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEiEE12promise_typeEE12from_addressB7v160000EPv(tmp4,tmp3,0);
		tmp3={a0:nullArray,a0o:0};
		__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEiEE12promise_typeEEcvS_IvEB7v160000Ev(tmp3,tmp4);
		__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed20,tmp3);
	}
	return tmp0;
}
function __ZN16TailscaleNetwork10TCPWrapper6acceptEPS_PN6client31ReadableStreamDefaultControllerIPNS2_6ObjectEEEi$presume(Larg0,Marg0){
	var L$poptgepsqueezed21=null,L$poptgepsqueezed22=null,tmp2=0,tmp3=null,tmp4=null,tmp5=null;
	L$poptgepsqueezed21=Larg0[Marg0].a2;
	L$poptgepsqueezed22=Larg0[Marg0].a8;
	a:{
		if((Larg0[Marg0].i9&3)!==0){
			tmp2=__ZZawIiEDaRN6client7PromiseIT_EEENK15promise_awaiter12await_resumeEv(L$poptgepsqueezed22)|0;
			__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed22);
			if((tmp2|0)<0){
				L$poptgepsqueezed22=Larg0[Marg0].a5;
				tmp3=Larg0[Marg0].a3;
				tmp4="Error on accept";
				L$poptgepsqueezed22.error(tmp4);
				L$poptgepsqueezed22="Error on accept";
				__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(tmp3,new Error(L$poptgepsqueezed22));
				__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEiEE12promise_type12return_valueES3_(L$poptgepsqueezed21);
				break a;
			}
		}
		Larg0[Marg0].i7=tmp2;
		tmp4=Larg0[Marg0].a3;
		tmp5=tmp4.a0.accept();
		if(tmp5!==null){
			tmp2=Larg0[Marg0].i6|0;
			L$poptgepsqueezed22=Larg0[Marg0].a5;
			tmp4=Larg0[Marg0].a4;
			tmp3={a0:null,a1:null,a2:null,a3:null,a4:null,a5:null,i6:0};
			__ZN16TailscaleNetwork10TCPWrapperC2EPN6client11IPTCPSocketE(tmp3,tmp5.socket);
			tmp4=tmp4.a0;
			tmp4=tmp4.dumpIP(tmp5.addr);
			__ZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjj(tmp3,tmp4,tmp5.port,tmp2);
			tmp4=tmp3.a1.promise;
			tmp5=tmp3.a2.promise;
			L$poptgepsqueezed22.enqueue({opened :tmp4, closed :tmp5, close :tmp3.a5});
			__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEiEE12promise_type12return_valueES3_(L$poptgepsqueezed21);
		}else{
			__ZawIiEDaRN6client7PromiseIT_EE(L$poptgepsqueezed22,tmp4.a0.waitIncoming());
			Larg0[Marg0].i9=1;
			L$poptgepsqueezed21={a0:nullArray,a0o:0};
			__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEiEE12promise_typeEE12from_addressB7v160000EPv(L$poptgepsqueezed21,Larg0,Marg0);
			tmp4={a0:nullArray,a0o:0};
			__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEiEE12promise_typeEEcvS_IvEB7v160000Ev(tmp4,L$poptgepsqueezed21);
			__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed22,tmp4);
		}
	}
}
function __ZN16TailscaleNetwork10TCPWrapper6acceptEPS_PN6client31ReadableStreamDefaultControllerIPNS2_6ObjectEEEi$pdestroy(Larg0,Marg0){
	Larg0=Larg0[Marg0];
	var tmp0=0;
	tmp0=Larg0.i9|0;
	if(Larg0.a0!==null)if((tmp0&3)!==0)__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0.a8);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEiEE12promise_type17get_return_objectEv(Larg0){
	var tmp0=null;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	return new Promise(_cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRN16TailscaleNetwork10TCPWrapperEPSM_PNS_31ReadableStreamDefaultControllerIPNS_6ObjectEEEiEE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(tmp0));
}
function __ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEiEE12promise_typeEE12from_addressB7v160000EPv(Larg0,Larg1,Marg1){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEiEE12promise_typeEEcvS_IvEB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEiEE12promise_typeEE7addressB7v160000Ev(Larg1);
	tmp1=oSlot;
	__ZNSt16coroutine_handleIvE12from_addressB7v160000EPv(Larg0,tmp0,tmp1);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEiEE12promise_type12return_valueES3_(Larg0){
	Larg0.a0.call(null,null);
}
function __ZN16TailscaleNetwork10TCPWrapperC2EPN6client11IPTCPSocketE(Larg0,Larg1){
	var tmp0=null;
	Larg0.a0=Larg1;
	Larg0.a1=__ZN6client20PromiseWithResolversIPNS_6ObjectEE6createEv();
	Larg0.a2=__ZN6client20PromiseWithResolversIPNS_4_AnyEE6createEv();
	Larg0.a3=null;
	Larg0.a4=null;
	Larg0.i6=0;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	Larg0.a5=__ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEEUlvE_EEPNS3_13EventListenerEOT_(tmp0);
}
function __ZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjj(Larg0,Larg1,Larg2,Larg3){
	var tmp0=null,tmp1=null;
	tmp0=_cheerpCreate_ZN6client16UnderlyingSourceIPNS_6ObjectEEC2Ev();
	tmp1={a0:null};
	tmp1.a0=Larg0;
	tmp0.pull=__ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlPNS3_28ReadableByteStreamControllerEE_EEPNS3_13EventListenerEOT_(tmp1);
	tmp1={a0:null};
	tmp1.a0=Larg0;
	tmp0.cancel=__ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE_EEPNS3_13EventListenerEOT_(tmp1);
	tmp0.type="bytes";
	tmp0.autoAllocateChunkSize=1500;
	Larg0.a3=new ReadableStream(tmp0);
	tmp0=_cheerpCreate_ZN6client14UnderlyingSinkIPNS_10Uint8ArrayEEC2Ev();
	tmp1={a0:null};
	tmp1.a0=Larg0;
	tmp0.write=__ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlPNS3_10Uint8ArrayEPNS3_31WritableStreamDefaultControllerEE_EEPNS3_13EventListenerEOT_(tmp1);
	tmp1={a0:null};
	tmp1.a0=Larg0;
	tmp0.close=__ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE0_EEPNS3_13EventListenerEOT_(tmp1);
	tmp1={a0:null};
	tmp1.a0=Larg0;
	tmp0.abort=__ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE1_EEPNS3_13EventListenerEOT_(tmp1);
	Larg0.a4=new WritableStream(tmp0);
	tmp0="0.0.0.0";
	tmp1=Larg0.a1.resolve;
	tmp1.call(null,{readable :Larg0.a3, writable :Larg0.a4, remoteAddress :Larg1, localAddress :tmp0, remotePort :Larg2, localPort :Larg3});
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlPNS3_28ReadableByteStreamControllerEE_EEPNS3_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlPNS3_28ReadableByteStreamControllerEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS9_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS9_Efp_EEEOS9_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_28ReadableByteStreamControllerEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_28ReadableByteStreamControllerEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE_EEPNS3_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS7_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS7_Efp_EEEOS7_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvvEEcvPN6client13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvvEED2Ev(tmp0);
	return tmp1;
}
function _cheerpCreate_ZN6client14UnderlyingSinkIPNS_10Uint8ArrayEEC2Ev(){
	return new Object();
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlPNS3_10Uint8ArrayEPNS3_31WritableStreamDefaultControllerEE_EEPNS3_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlPNS3_10Uint8ArrayEPNS3_31WritableStreamDefaultControllerEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISB_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISB_Efp_EEEOSB_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE0_EEPNS3_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE0_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS7_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS7_Efp_EEEOS7_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvvEEcvPN6client13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvvEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE1_EEPNS3_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE1_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS7_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS7_Efp_EEEOS7_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvvEEcvPN6client13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvvEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE1_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS7_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS7_Efp_EEEOS7_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE1_MS6_KFvvEE12make_closureEOS6_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE1_MS6_KFvvEE12make_closureEOS6_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE1_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISA_PS1_EE5valueEvE4typeEPNSD_IXntsrNS2_13_must_destroyISA_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE1_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISA_PS1_EE5valueEvE4typeEPNSD_IXntsrNS2_13_must_destroyISA_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE1_JEEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE1_JEEEvPT_DpT0_(Larg0){
	__ZZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjENKUlvE1_clEv(Larg0);
}
function __ZZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjENKUlvE1_clEv(Larg0){
	__ZN16TailscaleNetwork10TCPWrapper12doShutdownTxEv(Larg0.a0);
}
function __ZN16TailscaleNetwork10TCPWrapper12doShutdownTxEv(Larg0){
	var tmp0=null,Lmergedinsert=0;
	Lmergedinsert=Larg0.i6&255|256;
	Larg0.i6=Lmergedinsert;
	tmp0=Larg0.a0;
	if(tmp0!==null){
		tmp0.shutdownTx();
		Lmergedinsert=Larg0.i6|0;
	}
	if((Lmergedinsert&1)!==0)__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(Larg0,null);
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE0_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS7_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS7_Efp_EEEOS7_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE0_MS6_KFvvEE12make_closureEOS6_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE0_MS6_KFvvEE12make_closureEOS6_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE0_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISA_PS1_EE5valueEvE4typeEPNSD_IXntsrNS2_13_must_destroyISA_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE0_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISA_PS1_EE5valueEvE4typeEPNSD_IXntsrNS2_13_must_destroyISA_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE0_JEEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE0_JEEEvPT_DpT0_(Larg0){
	__ZZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjENKUlvE0_clEv(Larg0);
}
function __ZZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjENKUlvE0_clEv(Larg0){
	__ZN16TailscaleNetwork10TCPWrapper12doShutdownTxEv(Larg0.a0);
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlPNS3_10Uint8ArrayEPNS3_31WritableStreamDefaultControllerEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISB_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISB_Efp_EEEOSB_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlPNS3_10Uint8ArrayEPNS3_31WritableStreamDefaultControllerEE_MSA_KFPNS3_7PromiseIPNS3_4_AnyEEES7_S9_EE12make_closureEOSA_(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEEcvPNS1_13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEE14deleter_helperEPNSC_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEE14deleter_helperEPNSC_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlPNS3_10Uint8ArrayEPNS3_31WritableStreamDefaultControllerEE_MSA_KFPNS3_7PromiseIPNS3_4_AnyEEES7_S9_EE12make_closureEOSA_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEEC2IZN16TailscaleNetwork10TCPWrapper11setupClientEPNS1_6StringEjjEUlS8_SA_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISJ_PSB_EE5valueEvE4typeEPNSM_IXntsrNSC_13_must_destroyISJ_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEEC2IZN16TailscaleNetwork10TCPWrapper11setupClientEPNS1_6StringEjjEUlS8_SA_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISJ_PSB_EE5valueEvE4typeEPNSM_IXntsrNSC_13_must_destroyISJ_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN16TailscaleNetwork10TCPWrapper11setupClientEPNS1_6StringEjjEUlPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEE_JSE_SG_EEES6_PT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN16TailscaleNetwork10TCPWrapper11setupClientEPNS1_6StringEjjEUlPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEE_JSE_SG_EEES6_PT_DpT0_(Larg0,Larg1,Larg2){
	return __ZZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjENKUlPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEE_clES5_S7_(Larg0,Larg1,Larg2);
}
function __ZZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjENKUlPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEE_clES5_S7_(Larg0,Larg1,Larg2){
	return __ZN16TailscaleNetwork10TCPWrapper5writeEPN6client10Uint8ArrayEPNS1_31WritableStreamDefaultControllerE(Larg0.a0,Larg1,Larg2);
}
function __ZN16TailscaleNetwork10TCPWrapper5writeEPN6client10Uint8ArrayEPNS1_31WritableStreamDefaultControllerE(Larg0,Larg1,Larg2){
	var tmp0=null,tmp1=null,tmp2=null,tmp3=null,L$poptgepsqueezed17=null,tmp5=0,tmp6=0;
	tmp2=new constructor__ZN16TailscaleNetwork10TCPWrapper5writeEPN6client10Uint8ArrayEPNS1_31WritableStreamDefaultControllerE$pFrame().a;
	tmp3=tmp2[0];
	tmp3.a0=__ZN16TailscaleNetwork10TCPWrapper5writeEPN6client10Uint8ArrayEPNS1_31WritableStreamDefaultControllerE$presume;
	tmp3.a1=__ZN16TailscaleNetwork10TCPWrapper5writeEPN6client10Uint8ArrayEPNS1_31WritableStreamDefaultControllerE$pdestroy;
	tmp3.a5=Larg2;
	tmp3.a4=Larg1;
	tmp3.a3=Larg0;
	L$poptgepsqueezed17=tmp3.a2;
	tmp0=__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_10Uint8ArrayEPNS0_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEv(L$poptgepsqueezed17);
	tmp5=tmp3.a4.length;
	tmp3.i6=tmp5;
	tmp3.i7=0;
	a:{
		if((tmp5|0)!==0){
			tmp6=0;
			while(1){
				tmp5=tmp3.a3.a0.send(tmp3.a4,tmp6,tmp5-tmp6|0);
				tmp3.i8=tmp5;
				if((tmp5|0)===-11){
					L$poptgepsqueezed17=tmp3.a9;
					__ZawIiEDaRN6client7PromiseIT_EE(L$poptgepsqueezed17,tmp3.a3.a0.waitOutgoing());
					tmp3.i10=1;
					tmp3={a0:nullArray,a0o:0};
					__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEE12promise_typeEE12from_addressB7v160000EPv(tmp3,tmp2,0);
					tmp2={a0:nullArray,a0o:0};
					__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEE12promise_typeEEcvS_IvEB7v160000Ev(tmp2,tmp3);
					__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed17,tmp2);
					break a;
				}
				if((tmp5|0)<0){
					tmp2=tmp3.a5;
					tmp3=tmp3.a3;
					tmp1="Error on write";
					tmp2.error(tmp1);
					tmp2="Error on write";
					__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(tmp3,new Error(tmp2));
					__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_10Uint8ArrayEPNS0_31WritableStreamDefaultControllerEEE12promise_type12return_valueES3_(L$poptgepsqueezed17);
					break a;
				}
				tmp6=(tmp3.i7|0)+tmp5|0;
				tmp3.i7=tmp6;
				tmp5=tmp3.i6|0;
				if(tmp5>>>0>tmp6>>>0)continue;
				break;
			}
		}
		__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_10Uint8ArrayEPNS0_31WritableStreamDefaultControllerEEE12promise_type12return_valueES3_(L$poptgepsqueezed17);
	}
	return tmp0;
}
function __ZN16TailscaleNetwork10TCPWrapper5writeEPN6client10Uint8ArrayEPNS1_31WritableStreamDefaultControllerE$presume(Larg0,Marg0){
	var L$pdispatch8=0,tmp1=null,L$poptgepsqueezed32=null,L$poptgepsqueezed33=null,L$pdispatch6=0,Llabel=0,L$pdispatch=0,L$ppre=0,tmp8=null;
	L$poptgepsqueezed32=Larg0[Marg0].a2;
	L$poptgepsqueezed33=Larg0[Marg0].a9;
	if((Larg0[Marg0].i10&3)!==0){
		L$pdispatch6=__ZZawIiEDaRN6client7PromiseIT_EEENK15promise_awaiter12await_resumeEv(L$poptgepsqueezed33)|0;
		__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed33);
		if((L$pdispatch6|0)!==0){
			Llabel=0;
		}else{
			L$pdispatch=Larg0[Marg0].i7|0;
			Llabel=-1;
		}
	}else{
		L$ppre=Larg0[Marg0].a4.length;
		Larg0[Marg0].i6=L$ppre;
		L$pdispatch8=0;
		Llabel=1;
	}
	a:while(1){
		switch(Llabel|0){
			case 0:
			if((L$pdispatch6|0)<0){
				L$poptgepsqueezed33=Larg0[Marg0].a5;
				tmp1=Larg0[Marg0].a3;
				tmp8="Error on write";
				L$poptgepsqueezed33.error(tmp8);
				L$poptgepsqueezed33="Error on write";
				__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(tmp1,new Error(L$poptgepsqueezed33));
				__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_10Uint8ArrayEPNS0_31WritableStreamDefaultControllerEEE12promise_type12return_valueES3_(L$poptgepsqueezed32);
				break a;
			}
			Llabel=Larg0[Marg0].i7|0;
			L$pdispatch=Llabel+L$pdispatch6|0;
			Llabel=-1;
			continue a;
			case 1:
			Larg0[Marg0].i7=L$pdispatch8;
			if(L$ppre>>>0>L$pdispatch8>>>0){
				tmp8=Larg0[Marg0].a3;
				L$pdispatch6=tmp8.a0.send(Larg0[Marg0].a4,L$pdispatch8,L$ppre-L$pdispatch8|0);
				Larg0[Marg0].i8=L$pdispatch6;
				if((L$pdispatch6|0)===-11){
					__ZawIiEDaRN6client7PromiseIT_EE(L$poptgepsqueezed33,tmp8.a0.waitOutgoing());
					Larg0[Marg0].i10=1;
					L$poptgepsqueezed32={a0:nullArray,a0o:0};
					__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEE12promise_typeEE12from_addressB7v160000EPv(L$poptgepsqueezed32,Larg0,Marg0);
					tmp8={a0:nullArray,a0o:0};
					__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEE12promise_typeEEcvS_IvEB7v160000Ev(tmp8,L$poptgepsqueezed32);
					__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed33,tmp8);
					break a;
				}
				Llabel=0;
				continue a;
			}
			__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_10Uint8ArrayEPNS0_31WritableStreamDefaultControllerEEE12promise_type12return_valueES3_(L$poptgepsqueezed32);
			break a;
			default:
			L$ppre=Larg0[Marg0].i6|0;
			L$pdispatch8=L$pdispatch;
			Llabel=1;
			continue a;
		}
		break;
	}
}
function __ZN16TailscaleNetwork10TCPWrapper5writeEPN6client10Uint8ArrayEPNS1_31WritableStreamDefaultControllerE$pdestroy(Larg0,Marg0){
	Larg0=Larg0[Marg0];
	var tmp0=0;
	tmp0=Larg0.i10|0;
	if(Larg0.a0!==null)if((tmp0&3)!==0)__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0.a9);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_10Uint8ArrayEPNS0_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEv(Larg0){
	var tmp0=null;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	return new Promise(_cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRN16TailscaleNetwork10TCPWrapperEPNS_10Uint8ArrayEPNS_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(tmp0));
}
function __ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEE12promise_typeEE12from_addressB7v160000EPv(Larg0,Larg1,Marg1){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEE12promise_typeEEcvS_IvEB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEE12promise_typeEE7addressB7v160000Ev(Larg1);
	tmp1=oSlot;
	__ZNSt16coroutine_handleIvE12from_addressB7v160000EPv(Larg0,tmp0,tmp1);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_10Uint8ArrayEPNS0_31WritableStreamDefaultControllerEEE12promise_type12return_valueES3_(Larg0){
	Larg0.a0.call(null,null);
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEE12promise_typeEE7addressB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	oSlot=tmp1;
	return tmp0;
}
function _cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRN16TailscaleNetwork10TCPWrapperEPNS_10Uint8ArrayEPNS_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(Larg0){
	return __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS2_10Uint8ArrayEPNS2_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0);
}
function __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS2_10Uint8ArrayEPNS2_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS2_10Uint8ArrayEPNS2_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISL_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISL_Efp_EEEOSL_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client8FunctionEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS2_10Uint8ArrayEPNS2_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISL_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISL_Efp_EEEOSL_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS2_10Uint8ArrayEPNS2_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSJ_KFvSI_EE12make_closureESK_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS2_10Uint8ArrayEPNS2_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSJ_KFvSI_EE12make_closureESK_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISO_PS4_EE5valueEvE4typeEPNSR_IXntsrNS5_13_must_destroyISO_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_10Uint8ArrayEPNS1_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISO_PS4_EE5valueEvE4typeEPNSR_IXntsrNS5_13_must_destroyISO_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS4_10Uint8ArrayEPNS4_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSK_EEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS4_10Uint8ArrayEPNS4_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSK_EEEvPT_DpT0_(Larg0,Larg1){
	__ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_10Uint8ArrayEPNS0_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESG_(Larg0,Larg1);
}
function __ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_10Uint8ArrayEPNS0_31WritableStreamDefaultControllerEEE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESG_(Larg0,Larg1){
	Larg0.a0.a0=Larg1;
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS7_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS7_Efp_EEEOS7_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE_MS6_KFvvEE12make_closureEOS6_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE_MS6_KFvvEE12make_closureEOS6_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISA_PS1_EE5valueEvE4typeEPNSD_IXntsrNS2_13_must_destroyISA_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvvEEC2IZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISA_PS1_EE5valueEvE4typeEPNSD_IXntsrNS2_13_must_destroyISA_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE_JEEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlvE_JEEEvPT_DpT0_(Larg0){
	__ZZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjENKUlvE_clEv(Larg0);
}
function __ZZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjENKUlvE_clEv(Larg0){
	__ZN16TailscaleNetwork10TCPWrapper12doShutdownRxEv(Larg0.a0);
}
function __ZN16TailscaleNetwork10TCPWrapper12doShutdownRxEv(Larg0){
	var tmp0=null,Lmergedinsert=0;
	Lmergedinsert=Larg0.i6&65280|1;
	Larg0.i6=Lmergedinsert;
	tmp0=Larg0.a0;
	if(tmp0!==null){
		tmp0.shutdownRx();
		Lmergedinsert=Larg0.i6|0;
	}
	if((Lmergedinsert&256)!==0)__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(Larg0,null);
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlPNS3_28ReadableByteStreamControllerEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS9_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS9_Efp_EEEOS9_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlPNS3_28ReadableByteStreamControllerEE_MS8_KFPNS3_7PromiseIPNS3_4_AnyEEES7_EE12make_closureEOS8_(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_28ReadableByteStreamControllerEEEcvPNS1_13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_28ReadableByteStreamControllerEEE14deleter_helperEPNSA_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_28ReadableByteStreamControllerEEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_28ReadableByteStreamControllerEEE14deleter_helperEPNSA_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjEUlPNS3_28ReadableByteStreamControllerEE_MS8_KFPNS3_7PromiseIPNS3_4_AnyEEES7_EE12make_closureEOS8_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_28ReadableByteStreamControllerEEEC2IZN16TailscaleNetwork10TCPWrapper11setupClientEPNS1_6StringEjjEUlS8_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISH_PS9_EE5valueEvE4typeEPNSK_IXntsrNSA_13_must_destroyISH_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_28ReadableByteStreamControllerEEEC2IZN16TailscaleNetwork10TCPWrapper11setupClientEPNS1_6StringEjjEUlS8_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISH_PS9_EE5valueEvE4typeEPNSK_IXntsrNSA_13_must_destroyISH_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN16TailscaleNetwork10TCPWrapper11setupClientEPNS1_6StringEjjEUlPNS1_28ReadableByteStreamControllerEE_JSE_EEES6_PT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN16TailscaleNetwork10TCPWrapper11setupClientEPNS1_6StringEjjEUlPNS1_28ReadableByteStreamControllerEE_JSE_EEES6_PT_DpT0_(Larg0,Larg1){
	return __ZZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjENKUlPNS1_28ReadableByteStreamControllerEE_clES5_(Larg0,Larg1);
}
function __ZZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjjENKUlPNS1_28ReadableByteStreamControllerEE_clES5_(Larg0,Larg1){
	return __ZN16TailscaleNetwork10TCPWrapper4readEPN6client28ReadableByteStreamControllerE(Larg0.a0,Larg1);
}
function __ZN16TailscaleNetwork10TCPWrapper4readEPN6client28ReadableByteStreamControllerE(Larg0,Larg1){
	var tmp0=null,tmp1=-0.,tmp2=null,tmp3=null,L$poptgepsqueezed14=null,tmp5=null,tmp6=null,tmp7=0;
	tmp2=new constructor__ZN16TailscaleNetwork10TCPWrapper4readEPN6client28ReadableByteStreamControllerE$pFrame().a;
	tmp3=tmp2[0];
	tmp3.a0=__ZN16TailscaleNetwork10TCPWrapper4readEPN6client28ReadableByteStreamControllerE$presume;
	tmp3.a1=__ZN16TailscaleNetwork10TCPWrapper4readEPN6client28ReadableByteStreamControllerE$pdestroy;
	tmp3.a5=Larg1;
	tmp3.a4=Larg0;
	L$poptgepsqueezed14=tmp3.a2;
	tmp0=__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEv(L$poptgepsqueezed14);
	tmp5=tmp3.a5.byobRequest.view;
	tmp6=tmp5.buffer;
	tmp1=+tmp5.byteOffset;
	tmp3.a3=new Uint8Array(tmp6,tmp1,+tmp5.byteLength);
	tmp5=tmp3.a4.a0;
	tmp7=tmp3.a3.length;
	tmp7=tmp5.recv(tmp3.a3,0,tmp7);
	tmp3.i6=tmp7;
	if((tmp7|0)===-11){
		L$poptgepsqueezed14=tmp3.a7;
		__ZawIiEDaRN6client7PromiseIT_EE(L$poptgepsqueezed14,tmp3.a4.a0.waitIncoming());
		tmp3.i8=1;
		tmp3={a0:nullArray,a0o:0};
		__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_28ReadableByteStreamControllerEEE12promise_typeEE12from_addressB7v160000EPv(tmp3,tmp2,0);
		tmp2={a0:nullArray,a0o:0};
		__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_28ReadableByteStreamControllerEEE12promise_typeEEcvS_IvEB7v160000Ev(tmp2,tmp3);
		__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed14,tmp2);
	}else if((tmp7|0)!==0){
		tmp2=tmp3.a5;
		if((tmp7|0)<0){
			tmp5=tmp3.a4;
			tmp6="Error on read";
			tmp2.error(tmp6);
			tmp2="Error on read";
			__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(tmp5,new Error(tmp2));
			__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_28ReadableByteStreamControllerEEE12promise_type12return_valueES3_(L$poptgepsqueezed14);
		}else{
			tmp2.byobRequest.respond((+(tmp7|0)));
			__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_28ReadableByteStreamControllerEEE12promise_type12return_valueES3_(L$poptgepsqueezed14);
		}
	}else{
		tmp2=tmp3.a4;
		tmp3.a5.close();
		__ZN16TailscaleNetwork10TCPWrapper12doShutdownRxEv(tmp2);
		__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_28ReadableByteStreamControllerEEE12promise_type12return_valueES3_(L$poptgepsqueezed14);
	}
	return tmp0;
}
function __ZN16TailscaleNetwork10TCPWrapper4readEPN6client28ReadableByteStreamControllerE$presume(Larg0,Marg0){
	var tmp0=null,tmp1=-0.,L$poptgepsqueezed17=null,L$poptgepsqueezed18=null,tmp4=0,tmp5=null,tmp6=null;
	L$poptgepsqueezed17=Larg0[Marg0].a2;
	L$poptgepsqueezed18=Larg0[Marg0].a7;
	a:{
		b:{
			if((Larg0[Marg0].i8&3)!==0){
				tmp4=__ZZawIiEDaRN6client7PromiseIT_EEENK15promise_awaiter12await_resumeEv(L$poptgepsqueezed18)|0;
				__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed18);
				if((tmp4|0)!==0)break b;
			}else{
				tmp6=Larg0[Marg0].a5.byobRequest.view;
				tmp5=tmp6.buffer;
				tmp1=+tmp6.byteOffset;
				Larg0[Marg0].a3=new Uint8Array(tmp5,tmp1,+tmp6.byteLength);
			}
			tmp6=Larg0[Marg0].a4;
			tmp5=tmp6.a0;
			tmp0=Larg0[Marg0].a3;
			tmp4=tmp5.recv(tmp0,0,tmp0.length);
			Larg0[Marg0].i6=tmp4;
			if((tmp4|0)===-11){
				__ZawIiEDaRN6client7PromiseIT_EE(L$poptgepsqueezed18,tmp6.a0.waitIncoming());
				Larg0[Marg0].i8=1;
				L$poptgepsqueezed17={a0:nullArray,a0o:0};
				__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_28ReadableByteStreamControllerEEE12promise_typeEE12from_addressB7v160000EPv(L$poptgepsqueezed17,Larg0,Marg0);
				tmp6={a0:nullArray,a0o:0};
				__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_28ReadableByteStreamControllerEEE12promise_typeEEcvS_IvEB7v160000Ev(tmp6,L$poptgepsqueezed17);
				__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed18,tmp6);
				break a;
			}
			if((tmp4|0)===0){
				Larg0[Marg0].a5.close();
				__ZN16TailscaleNetwork10TCPWrapper12doShutdownRxEv(tmp6);
				__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_28ReadableByteStreamControllerEEE12promise_type12return_valueES3_(L$poptgepsqueezed17);
				break a;
			}
		}
		L$poptgepsqueezed18=Larg0[Marg0].a5;
		if((tmp4|0)<0){
			tmp5=Larg0[Marg0].a4;
			tmp6="Error on read";
			L$poptgepsqueezed18.error(tmp6);
			L$poptgepsqueezed18="Error on read";
			__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(tmp5,new Error(L$poptgepsqueezed18));
			__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_28ReadableByteStreamControllerEEE12promise_type12return_valueES3_(L$poptgepsqueezed17);
		}else{
			L$poptgepsqueezed18.byobRequest.respond((+(tmp4|0)));
			__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_28ReadableByteStreamControllerEEE12promise_type12return_valueES3_(L$poptgepsqueezed17);
		}
	}
}
function __ZN16TailscaleNetwork10TCPWrapper4readEPN6client28ReadableByteStreamControllerE$pdestroy(Larg0,Marg0){
	Larg0=Larg0[Marg0];
	var tmp0=0;
	tmp0=Larg0.i8|0;
	if(Larg0.a0!==null)if((tmp0&3)!==0)__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0.a7);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEv(Larg0){
	var tmp0=null;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	return new Promise(_cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRN16TailscaleNetwork10TCPWrapperEPNS_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(tmp0));
}
function __ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_28ReadableByteStreamControllerEEE12promise_typeEE12from_addressB7v160000EPv(Larg0,Larg1,Marg1){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_28ReadableByteStreamControllerEEE12promise_typeEEcvS_IvEB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_28ReadableByteStreamControllerEEE12promise_typeEE7addressB7v160000Ev(Larg1);
	tmp1=oSlot;
	__ZNSt16coroutine_handleIvE12from_addressB7v160000EPv(Larg0,tmp0,tmp1);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_28ReadableByteStreamControllerEEE12promise_type12return_valueES3_(Larg0){
	Larg0.a0.call(null,null);
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_28ReadableByteStreamControllerEEE12promise_typeEE7addressB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	oSlot=tmp1;
	return tmp0;
}
function _cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRN16TailscaleNetwork10TCPWrapperEPNS_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(Larg0){
	return __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS2_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0);
}
function __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS2_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS2_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISJ_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISJ_Efp_EEEOSJ_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client8FunctionEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS2_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISJ_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISJ_Efp_EEEOSJ_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS2_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSH_KFvSG_EE12make_closureESI_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS2_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSH_KFvSG_EE12make_closureESI_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISM_PS4_EE5valueEvE4typeEPNSP_IXntsrNS5_13_must_destroyISM_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS1_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISM_PS4_EE5valueEvE4typeEPNSP_IXntsrNS5_13_must_destroyISM_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS4_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSI_EEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS4_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSI_EEEvPT_DpT0_(Larg0,Larg1){
	__ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESE_(Larg0,Larg1);
}
function __ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPNS0_28ReadableByteStreamControllerEEE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESE_(Larg0,Larg1){
	Larg0.a0.a0=Larg1;
}
function __ZN6cheerp8CallbackIZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEEUlvE_EEPNS3_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS7_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS7_Efp_EEEOS7_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS7_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS7_Efp_EEEOS7_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEEUlvE_MS6_KFPNS3_7PromiseIPNS3_4_AnyEEEvEE12make_closureEOS6_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEEUlvE_MS6_KFPNS3_7PromiseIPNS3_4_AnyEEEvEE12make_closureEOS6_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEEC2IZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISF_PS7_EE5valueEvE4typeEPNSI_IXntsrNS8_13_must_destroyISF_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEEC2IZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISF_PS7_EE5valueEvE4typeEPNSI_IXntsrNS8_13_must_destroyISF_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_JEEES6_PT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_JEEES6_PT_DpT0_(Larg0){
	return __ZZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEENKUlvE_clEv(Larg0);
}
function __ZZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEENKUlvE_clEv(Larg0){
	var L$poptgepsqueezed8=null,tmp1=null,tmp2=null,tmp3=null;
	tmp1=Larg0.a0;
	tmp2=new constructor__ZZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEENKUlvE_clEv$pFrame().a;
	tmp3=tmp2[0];
	tmp3.a0=__ZZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEENKUlvE_clEv$presume;
	tmp3.a1=__ZZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEENKUlvE_clEv$pdestroy;
	tmp3.a3=tmp1;
	tmp1=__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS0_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEv(tmp3.a2);
	L$poptgepsqueezed8=tmp3.a4;
	__ZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed8,tmp3.a3.a3.cancel());
	tmp3.i6=1;
	tmp3={a0:nullArray,a0o:0};
	__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EE12promise_typeEE12from_addressB7v160000EPv(tmp3,tmp2,0);
	tmp2={a0:nullArray,a0o:0};
	__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(tmp2,tmp3);
	__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed8,tmp2);
	return tmp1;
}
function __ZZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEENKUlvE_clEv$presume(Larg0,Marg0){
	var tmp0=0,L$poptgepsqueezed7=null,tmp2=null,tmp3=null,tmp4=null,L$poptgepsqueezed8=null;
	tmp0=Larg0[Marg0].i6|0;
	L$poptgepsqueezed7=Larg0[Marg0].a5;
	a:{
		if(tmp0<<30>-1073741824){
			L$poptgepsqueezed8=Larg0[Marg0].a4;
			tmp2={a0:nullArray,a0o:0};
			tmp3={a0:nullArray,a0o:0};
			if((tmp0&3)===0){
				__ZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed8,Larg0[Marg0].a3.a3.cancel());
				Larg0[Marg0].i6=1;
				__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EE12promise_typeEE12from_addressB7v160000EPv(tmp2,Larg0,Marg0);
				__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(tmp3,tmp2);
				__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed8,tmp3);
				break a;
			}
			__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed8);
			L$poptgepsqueezed8=Larg0[Marg0].a3;
			tmp4=L$poptgepsqueezed8.a4;
			if(tmp4!==null){
				__ZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed7,tmp4.abort());
				Larg0[Marg0].i6=2;
				__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EE12promise_typeEE12from_addressB7v160000EPv(tmp2,Larg0,Marg0);
				__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(tmp3,tmp2);
				__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed7,tmp3);
				break a;
			}
		}else{
			__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed7);
			L$poptgepsqueezed8=Larg0[Marg0].a3;
		}
		__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(L$poptgepsqueezed8,null);
		__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS0_11IPTCPSocketEEUlvE_EE12promise_type12return_valueES3_(Larg0[Marg0].a2);
	}
}
function __ZZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEENKUlvE_clEv$pdestroy(Larg0,Marg0){
	Larg0=Larg0[Marg0];
	var tmp0=0,L$psink=null;
	tmp0=Larg0.i6|0;
	a:if(Larg0.a0!==null){
		if(tmp0<<30>-1073741824){
			if((tmp0&3)===0)break a;
			L$psink=Larg0.a4;
		}else{
			L$psink=Larg0.a5;
		}
		__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(L$psink);
	}
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS0_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEv(Larg0){
	var tmp0=null;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	return new Promise(_cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(tmp0));
}
function __ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EE12promise_typeEE12from_addressB7v160000EPv(Larg0,Larg1,Marg1){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EE12promise_typeEE7addressB7v160000Ev(Larg1);
	tmp1=oSlot;
	__ZNSt16coroutine_handleIvE12from_addressB7v160000EPv(Larg0,tmp0,tmp1);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS0_11IPTCPSocketEEUlvE_EE12promise_type12return_valueES3_(Larg0){
	Larg0.a0.call(null,null);
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EE12promise_typeEE7addressB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	oSlot=tmp1;
	return tmp0;
}
function _cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(Larg0){
	return __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS2_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0);
}
function __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS2_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS2_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISL_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISL_Efp_EEEOSL_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client8FunctionEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS2_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISL_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISL_Efp_EEEOSL_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS2_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSJ_KFvSI_EE12make_closureESK_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS2_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSJ_KFvSI_EE12make_closureESK_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISO_PS4_EE5valueEvE4typeEPNSR_IXntsrNS5_13_must_destroyISO_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS1_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISO_PS4_EE5valueEvE4typeEPNSR_IXntsrNS5_13_must_destroyISO_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS4_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSK_EEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS4_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSK_EEEvPT_DpT0_(Larg0,Larg1){
	__ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS0_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESG_(Larg0,Larg1);
}
function __ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN16TailscaleNetwork10TCPWrapperC1EPNS0_11IPTCPSocketEEUlvE_EE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESG_(Larg0,Larg1){
	Larg0.a0.a0=Larg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS7_PNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEiEE12promise_typeEE7addressB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	oSlot=tmp1;
	return tmp0;
}
function _cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRN16TailscaleNetwork10TCPWrapperEPSM_PNS_31ReadableStreamDefaultControllerIPNS_6ObjectEEEiEE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(Larg0){
	return __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS8_PNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEiEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0);
}
function __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS8_PNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEiEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS8_PNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEiEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISN_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISN_Efp_EEEOSN_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client8FunctionEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS8_PNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEiEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISN_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISN_Efp_EEEOSN_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS8_PNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEiEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSL_KFvSK_EE12make_closureESM_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS8_PNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEiEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSL_KFvSK_EE12make_closureESM_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPSD_PNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEiEE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISQ_PS4_EE5valueEvE4typeEPNST_IXntsrNS5_13_must_destroyISQ_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPSD_PNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEiEE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISQ_PS4_EE5valueEvE4typeEPNST_IXntsrNS5_13_must_destroyISQ_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPSA_PNS4_31ReadableStreamDefaultControllerIPNS4_6ObjectEEEiEE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSM_EEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPSA_PNS4_31ReadableStreamDefaultControllerIPNS4_6ObjectEEEiEE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSM_EEEvPT_DpT0_(Larg0,Larg1){
	__ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEiEE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESI_(Larg0,Larg1);
}
function __ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRN16TailscaleNetwork10TCPWrapperEPS6_PNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEiEE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESI_(Larg0,Larg1){
	Larg0.a0.a0=Larg1;
}
function __ZN16TailscaleNetwork10TCPWrapper10makeSocketEPS_(Larg0){
	return new Larg0.a0.tcpSocket();
}
function __ZN16TailscaleNetwork10TCPWrapper7connectEPS_PN6client6StringEj(Larg0,Larg1,Larg2,Larg3,Larg4){
	var L$poptgepsqueezed20=null,tmp1=null,tmp2=null,tmp3=null,tmp4=0;
	tmp1=new constructor__ZN16TailscaleNetwork10TCPWrapper7connectEPS_PN6client6StringEj$pFrame().a;
	tmp2=tmp1[0];
	tmp2.a0=__ZN16TailscaleNetwork10TCPWrapper7connectEPS_PN6client6StringEj$presume;
	tmp2.a1=__ZN16TailscaleNetwork10TCPWrapper7connectEPS_PN6client6StringEj$pdestroy;
	tmp2.i10=Larg4;
	tmp2.a9=Larg3;
	tmp2.a8=Larg2;
	tmp2.a7=Larg1;
	__ZN6Thread12promise_type17get_return_objectEv(Larg0,tmp2.a2);
	tmp3=tmp2.a7;
	tmp4=tmp2.a8.a0.parseIP(tmp2.a9);
	if(((tmp3.a0.bind(0))|0)!==0){
		tmp3=tmp2.a7;
		tmp1="Cannot bind";
		tmp2=new Error(tmp1);
		tmp3.a1.reject.call(null,tmp2);
		__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(tmp3,tmp2);
	}else{
		tmp4=tmp2.a7.a0.connect(tmp4,tmp2.i10|0);
		tmp2.i11=tmp4;
		tmp3=tmp2.a7;
		if((tmp4|0)!==0){
			tmp1="Connection failed";
			tmp2=new Error(tmp1);
			tmp3.a1.reject.call(null,tmp2);
			__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(tmp3,tmp2);
		}else{
			L$poptgepsqueezed20=tmp2.a3;
			__ZawIiEDaRN6client7PromiseIT_EE(L$poptgepsqueezed20,tmp3.a0.waitOutgoing());
			tmp2.i4=1;
			tmp3={a0:nullArray,a0o:0};
			__ZNSt16coroutine_handleIN6Thread12promise_typeEE12from_addressB7v160000EPv(tmp3,tmp1,0);
			tmp1={a0:nullArray,a0o:0};
			__ZNKSt16coroutine_handleIN6Thread12promise_typeEEcvS_IvEB7v160000Ev(tmp1,tmp3);
			__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed20,tmp1);
		}
	}
}
function __ZN16TailscaleNetwork10TCPWrapper7connectEPS_PN6client6StringEj$presume(Larg0,Marg0){
	var L$poptgepsqueezed22=null,tmp1=0,tmp2=null,tmp3=null;
	L$poptgepsqueezed22=Larg0[Marg0].a3;
	if((Larg0[Marg0].i4&3)!==0){
		tmp1=__ZZawIiEDaRN6client7PromiseIT_EEENK15promise_awaiter12await_resumeEv(L$poptgepsqueezed22)|0;
		__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed22);
		if((tmp1|0)!==0){
			L$poptgepsqueezed22=Larg0[Marg0].a7;
			tmp2="Connection rejected";
			tmp3=new Error(tmp2);
			L$poptgepsqueezed22.a1.reject.call(null,tmp3);
			__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(L$poptgepsqueezed22,tmp3);
		}else __ZN16TailscaleNetwork10TCPWrapper11setupClientEPN6client6StringEjj(Larg0[Marg0].a7,Larg0[Marg0].a9,Larg0[Marg0].i10|0,0);
	}else{
		tmp2=Larg0[Marg0].a7;
		tmp1=Larg0[Marg0].a8.a0.parseIP(Larg0[Marg0].a9);
		if(((tmp2.a0.bind(0))|0)!==0){
			L$poptgepsqueezed22="Cannot bind";
			tmp3=new Error(L$poptgepsqueezed22);
			tmp2.a1.reject.call(null,tmp3);
			__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(tmp2,tmp3);
		}else{
			tmp1=tmp2.a0.connect(tmp1,Larg0[Marg0].i10|0);
			Larg0[Marg0].i11=tmp1;
			if((tmp1|0)!==0){
				L$poptgepsqueezed22="Connection failed";
				tmp3=new Error(L$poptgepsqueezed22);
				tmp2.a1.reject.call(null,tmp3);
				__ZN16TailscaleNetwork10TCPWrapper5closeEPN6client5ErrorE(tmp2,tmp3);
			}else{
				__ZawIiEDaRN6client7PromiseIT_EE(L$poptgepsqueezed22,tmp2.a0.waitOutgoing());
				Larg0[Marg0].i4=1;
				tmp2={a0:nullArray,a0o:0};
				__ZNSt16coroutine_handleIN6Thread12promise_typeEE12from_addressB7v160000EPv(tmp2,Larg0,Marg0);
				tmp3={a0:nullArray,a0o:0};
				__ZNKSt16coroutine_handleIN6Thread12promise_typeEEcvS_IvEB7v160000Ev(tmp3,tmp2);
				__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed22,tmp3);
			}
		}
	}
}
function __ZN16TailscaleNetwork10TCPWrapper7connectEPS_PN6client6StringEj$pdestroy(Larg0,Marg0){
	Larg0=Larg0[Marg0];
	var tmp0=0;
	tmp0=Larg0.i4|0;
	if(Larg0.a0!==null)if((tmp0&3)!==0)__ZZawIiEDaRN6client7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0.a3);
}
function __ZN6Thread12promise_type17get_return_objectEv(Larg0,Larg1){
	var tmp0=null;
	tmp0={a0:nullArray,a0o:0};
	__ZNSt16coroutine_handleIN6Thread12promise_typeEE12from_promiseB7v160000ERS1_(tmp0,Larg1);
	__ZN6ThreadC2ESt16coroutine_handleINS_12promise_typeEE(Larg0,tmp0);
}
function __ZNSt16coroutine_handleIN6Thread12promise_typeEE12from_addressB7v160000EPv(Larg0,Larg1,Marg1){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
}
function __ZNKSt16coroutine_handleIN6Thread12promise_typeEEcvS_IvEB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt16coroutine_handleIN6Thread12promise_typeEE7addressB7v160000Ev(Larg1);
	tmp1=oSlot;
	__ZNSt16coroutine_handleIvE12from_addressB7v160000EPv(Larg0,tmp0,tmp1);
}
function __ZNKSt16coroutine_handleIN6Thread12promise_typeEE7addressB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	oSlot=tmp1;
	return tmp0;
}
function __ZNSt16coroutine_handleIN6Thread12promise_typeEE12from_promiseB7v160000ERS1_(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=Larg1.a;
	tmp1=Larg1.o-1;
	Larg0.a0=tmp0;
	Larg0.a0o=tmp1;
}
function __ZN6ThreadC2ESt16coroutine_handleINS_12promise_typeEE(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=Larg1.a0;
	tmp1=Larg1.a0o|0;
	Larg0.a0=tmp0;
	Larg0.a0o=tmp1;
}
function __ZN13StreamNetwork9TCPSocketEPN6client6StringEj(Larg0,Larg1,Larg2){
	var tmp0=null,tmp1=0,tmp2=0,tmp3=null,tmp4=null,tmp5=null,tmp6=null;
	tmp4={a0:null,i1:0};
	tmp4.a0=Larg1;
	tmp4.i1=Larg2;
	tmp5={a0:null};
	__ZNSt3mapIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueESt4lessIS1_ESaISt4pairIKS1_S2_EEE4findB7v160000ERS6_(tmp5,Larg0,tmp4);
	tmp4={a0:null};
	__ZNSt3mapIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueESt4lessIS1_ESaISt4pairIKS1_S2_EEE3endB7v160000Ev(tmp4,Larg0);
	if(__ZSteqB7v160000RKSt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEESD_(tmp5,tmp4)|0){
		tmp4=Promise.reject(null);
		tmp5=Promise.reject(null);
		return {opened :tmp4, closed :tmp5, close :__ZN6cheerp8CallbackIZN13StreamNetwork9TCPSocketEPN6client6StringEjEUlvE_EEPNS2_13EventListenerEOT_()};
	}
	tmp6={a0:[null],a1:[null]};
	__ZN13StreamNetwork13cross_streamsEv(tmp6);
	tmp0=__ZSt3getB7v160000ILj0EPN13StreamNetwork9TCPClientES2_EONSt13tuple_elementIXT_ESt4pairIT0_T1_EE4typeEOS7_(tmp6);
	tmp1=oSlot;
	tmp4=__ZSt3getB7v160000ILj1EPN13StreamNetwork9TCPClientES2_EONSt13tuple_elementIXT_ESt4pairIT0_T1_EE4typeEOS7_(tmp6);
	tmp2=oSlot;
	tmp3="0.0.0.0";
	tmp6=__ZN13StreamNetwork13makeTCPSocketEPNS_9TCPClientEPKN6client6StringEjS5_j(tmp0[tmp1],tmp3,1000,Larg1,Larg2);
	tmp4=__ZN13StreamNetwork13makeTCPSocketEPNS_9TCPClientEPKN6client6StringEjS5_j(tmp4[tmp2],Larg1,Larg2,tmp3,1000);
	tmp5=__ZNKSt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEEptB7v160000Ev(tmp5);
	__ZN13StreamNetwork11AcceptQueue4pushEPN6client6ObjectEPNS1_8FunctionE(tmp5.a2,tmp4,tmp0[tmp1].a2.resolve);
	return tmp6;
}
function __ZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsE(Larg0,Larg1,Larg2){
	var tmp0=0,tmp1=0,tmp2=null,tmp3=null,tmp4=null;
	tmp0=Larg2.localPort;
	tmp2={a0:null,i1:0};
	tmp2.a0=Larg1;
	tmp2.i1=tmp0;
	tmp3={a0:null};
	__ZSt16forward_as_tupleB7v160000IJRN13StreamNetwork11ServiceAddrEEESt5tupleIJDpOT_EES6_(tmp3,tmp2);
	tmp2={a0:null,a1:[0]};
	__ZNSt3mapIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueESt4lessIS1_ESaISt4pairIKS1_S2_EEE7emplaceB7v160000IJRKSt21piecewise_construct_tSt5tupleIJRS1_EESE_IJEEEEES5_ISt14__map_iteratorISt15__tree_iteratorISt12__value_typeIS1_S2_EPSt11__tree_nodeISL_PvElEEbEDpOT_(tmp2,Larg0,tmp3);
	tmp3=__ZSt3getB7v160000ILj1ESt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS3_11AcceptQueueEEPSt11__tree_nodeIS6_PvElEEbEONSt13tuple_elementIXT_ESt4pairIT0_T1_EE4typeEOSH_(tmp2);
	tmp1=oSlot;
	if((tmp3[tmp1]&1)!==0){
		tmp3=__ZSt3getB7v160000ILj0ESt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS3_11AcceptQueueEEPSt11__tree_nodeIS6_PvElEEbEONSt13tuple_elementIXT_ESt4pairIT0_T1_EE4typeEOSH_(tmp2);
		tmp2=_cheerpCreate_ZN6client23UnderlyingDefaultSourceIPNS_6ObjectEEC2Ev();
		tmp4={a0:null,a1:{a0:null}};
		tmp4.a0=Larg0;
		tmp4.a1.a0=tmp3.a0;
		tmp2.pull=__ZN6cheerp8CallbackIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS2_22TCPServerSocketOptionsEEUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_EEPNS2_13EventListenerEOT_(tmp4);
		tmp4={a0:null,a1:{a0:null}};
		tmp4.a0=Larg0;
		tmp4.a1.a0=tmp3.a0;
		tmp2.cancel=__ZN6cheerp8CallbackIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS2_22TCPServerSocketOptionsEEUlvE_EEPNS2_13EventListenerEOT_(tmp4);
		tmp3=new ReadableStream(tmp2);
		tmp2={a0:null,a1:null,a2:null};
		__ZN13StreamNetwork9TCPServerC2EPN6client14ReadableStreamIPNS1_6ObjectEEE(tmp2,tmp3);
		return __ZN13StreamNetwork19makeTCPServerSocketEPNS_9TCPServerEPKN6client6StringEj(tmp2,Larg1,tmp0);
	}
	___assert_fail(_$pstr$p1$p2,0,_$pstr$p2$p3,0,170,___func__$p_ZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsE,0);
	;
}
function __ZN13StreamNetwork9UDPSocketEPN6client16UDPSocketOptionsE(Larg0,Larg1){
	return null;
}
function __ZN13StreamNetwork2upEv(Larg0){
	return Promise.resolve(null);
}
function __ZN13StreamNetwork3newEPN6client6ObjectE(Larg0){
	var tmp0=null;
	tmp0={a0:[null],a1:{a0:[null]},a2:[0]};
	__ZN13StreamNetworkC1EPN6client6ObjectE(tmp0);
	return tmp0;
}
function __ZN13StreamNetwork6deleteEv(Larg0){
	__ZN13StreamNetworkD1Ev(Larg0);
}
function __ZN13StreamNetworkC1EPN6client6ObjectE(Larg0){
	__ZNSt3mapIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueESt4lessIS1_ESaISt4pairIKS1_S2_EEEC2B7v160000Ev(Larg0);
}
function __ZN13StreamNetworkD1Ev(Larg0){
	__ZN13StreamNetworkD2Ev(Larg0);
}
function __ZN13StreamNetworkD2Ev(Larg0){
	__ZNSt3mapIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueESt4lessIS1_ESaISt4pairIKS1_S2_EEED2B7v160000Ev(Larg0);
}
function __ZNSt3mapIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueESt4lessIS1_ESaISt4pairIKS1_S2_EEED2B7v160000Ev(Larg0){
	__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EED2Ev(Larg0);
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EED2Ev(Larg0){
	__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE7destroyEPSt11__tree_nodeIS4_PvE(Larg0,__ZNKSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE6__rootB7v160000Ev(Larg0));
}
function __ZNKSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE6__rootB7v160000Ev(Larg0){
	return __ZNKSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10__end_nodeB7v160000Ev(Larg0).a0[0];
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE7destroyEPSt11__tree_nodeIS4_PvE(Larg0,Larg1){
	if(Larg1!==null){
		__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE7destroyEPSt11__tree_nodeIS4_PvE(Larg0,Larg1.a0[0]);
		__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE7destroyEPSt11__tree_nodeIS4_PvE(Larg0,Larg1.a1[0]);
		__ZNSt16allocator_traitsISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEEE7destroyB7v160000ISt4pairIKS3_S4_EvvEEvRS8_PT_(__ZNSt22__tree_key_value_typesISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEE9__get_ptrB7v160000ERS4_(Larg1.a4));
	}
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE12__node_allocB7v160000Ev(Larg0){
	return __ZNSt17__compressed_pairISt15__tree_end_nodeIPSt16__tree_node_baseIPvEESaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS8_11AcceptQueueEES2_EEE6secondB7v160000Ev(Larg0.a1);
}
function __ZNSt22__tree_key_value_typesISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEE9__get_ptrB7v160000ERS4_(Larg0){
	return __ZNSt12__value_typeIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEE11__get_valueB7v160000Ev(Larg0);
}
function __ZNSt16allocator_traitsISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEEE7destroyB7v160000ISt4pairIKS3_S4_EvvEEvRS8_PT_(Larg0){
	__ZSt10destroy_atB7v160000ISt4pairIKN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEELi0EEvPT_(Larg0);
}
function __ZSt10destroy_atB7v160000ISt4pairIKN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEELi0EEvPT_(Larg0){
	__ZSt12__destroy_atB7v160000ISt4pairIKN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEELi0EEvPT_(Larg0);
}
function __ZSt12__destroy_atB7v160000ISt4pairIKN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEELi0EEvPT_(Larg0){
	__ZNSt4pairIKN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEED2Ev(Larg0);
}
function __ZNSt4pairIKN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEED2Ev(Larg0){
	__ZN13StreamNetwork11AcceptQueueD2Ev(Larg0.a2);
}
function __ZN13StreamNetwork11AcceptQueueD2Ev(Larg0){
	__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EED2B7v160000Ev(Larg0.a3);
}
function __ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EED2B7v160000Ev(Larg0){
	__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE5clearEv(Larg0);
	__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EED2Ev(Larg0);
}
function __ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE5clearEv(Larg0){
	var tmp0=null,tmp1=null,L$plcssa=0;
	tmp1={a0:nullArray,a0o:0,a1:nullArray,a1o:0};
	__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE5beginB7v160000Ev(tmp1,Larg0);
	tmp0={a0:nullArray,a0o:0,a1:nullArray,a1o:0};
	__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE3endB7v160000Ev(tmp0,Larg0);
	if(__ZStneB7v160000RKSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EES8_(tmp1,tmp0)|0)while(1){
		__ZNSt16allocator_traitsISaIN13StreamNetwork11AcceptQueue7PendingEEE7destroyB7v160000IS2_vvEEvRS3_PT_(__ZNKSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EEdeB7v160000Ev(tmp1));
		__ZNSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EEppB7v160000Ev(tmp1);
		if(__ZStneB7v160000RKSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EES8_(tmp1,tmp0)|0)continue;
		break;
	}
	tmp1=__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE6__sizeB7v160000Ev(Larg0);
	L$plcssa=oSlot;
	tmp1[L$plcssa]=0;
	L$plcssa=__ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE4sizeB7v160000Ev(Larg0)|0;
	if(L$plcssa>>>0>2)while(1){
		__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9pop_frontB7v160000Ev(Larg0);
		L$plcssa=__ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE4sizeB7v160000Ev(Larg0)|0;
		if(L$plcssa>>>0>2)continue;
		break;
	}
	if((L$plcssa|0)===1)Larg0.i4=256;
	else if((L$plcssa|0)===2)Larg0.i4=512;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5beginB7v160000Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1[0];
	oSlot=tmp0.o;
	return tmp0.d;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE3endB7v160000Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a2[0];
	oSlot=tmp0.o;
	return tmp0.d;
}
function __ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE7__allocB7v160000Ev(Larg0){
	return __ZNSt17__compressed_pairIjSaIN13StreamNetwork11AcceptQueue7PendingEEE6secondB7v160000Ev(Larg0.a5[0]);
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EED2Ev(Larg0){
	__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5clearB7v160000Ev(Larg0);
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5clearB7v160000Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1[0];
	__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE17__destruct_at_endB7v160000EPS3_(Larg0,tmp0.d,tmp0.o);
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE7__allocB7v160000Ev(Larg0){
	return __ZNSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE6secondB7v160000Ev(Larg0.a3);
}
function __ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE8capacityB7v160000Ev(Larg0){
	var tmp0=0,tmp1=null,tmp2=null;
	tmp2=__ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9__end_capB7v160000Ev(Larg0);
	tmp0=oSlot;
	tmp2=tmp2[tmp0];
	tmp1=Larg0.a0[0];
	return (__imul(tmp2.o,4))-(__imul(tmp1.o,4))>>2|0;
}
function __ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9__end_capB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5firstB7v160000Ev(Larg0.a3);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNKSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5firstB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt22__compressed_pair_elemIPPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EE5__getB7v160000Ev(Larg0);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNKSt22__compressed_pair_elemIPPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EE5__getB7v160000Ev(Larg0){
	oSlot=0;
	return Larg0.a0;
}
function __ZNSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE6secondB7v160000Ev(Larg0){
	return __ZNSt22__compressed_pair_elemISaIPN13StreamNetwork11AcceptQueue7PendingEELi1ELb1EE5__getB7v160000Ev(Larg0);
}
function __ZNSt22__compressed_pair_elemISaIPN13StreamNetwork11AcceptQueue7PendingEELi1ELb1EE5__getB7v160000Ev(Larg0){
	return Larg0;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE17__destruct_at_endB7v160000EPS3_(Larg0,Larg1,Marg1){
	__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE17__destruct_at_endB7v160000EPS3_St17integral_constantIbLb0EE(Larg0,Larg1,Marg1);
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE17__destruct_at_endB7v160000EPS3_St17integral_constantIbLb0EE(Larg0,Larg1,Marg1){
	var L$ppromoted=null,Lgeptoindexphi=0;
	L$ppromoted=Larg0.a2[0];
	if(L$ppromoted.d!==Larg1||L$ppromoted.o!==Marg1){
		Lgeptoindexphi=0;
		while(1){
			Lgeptoindexphi=Lgeptoindexphi-1|0;
			__ZNSt16allocator_traitsISaIPN13StreamNetwork11AcceptQueue7PendingEEE7destroyB7v160000IS3_vvEEvRS4_PT_(L$ppromoted.d[L$ppromoted.o+Lgeptoindexphi|0]);
			if(L$ppromoted.d!==Larg1||(L$ppromoted.o+Lgeptoindexphi|0)!==Marg1)continue;
			break;
		}
		Larg0.a2[0]={d:Larg1,o:Marg1};
	}
}
function __ZNSt16allocator_traitsISaIPN13StreamNetwork11AcceptQueue7PendingEEE7destroyB7v160000IS3_vvEEvRS4_PT_(Larg0){
	__ZSt10destroy_atB7v160000IPN13StreamNetwork11AcceptQueue7PendingELi0EEvPT_(Larg0);
}
function __ZSt10destroy_atB7v160000IPN13StreamNetwork11AcceptQueue7PendingELi0EEvPT_(Larg0){
	__ZSt12__destroy_atB7v160000IPN13StreamNetwork11AcceptQueue7PendingELi0EEvPT_(Larg0);
}
function __ZSt12__destroy_atB7v160000IPN13StreamNetwork11AcceptQueue7PendingELi0EEvPT_(Larg0){
}
function __ZNSt17__compressed_pairIjSaIN13StreamNetwork11AcceptQueue7PendingEEE6secondB7v160000Ev(Larg0){
	return __ZNSt22__compressed_pair_elemISaIN13StreamNetwork11AcceptQueue7PendingEELi1ELb1EE5__getB7v160000Ev(Larg0);
}
function __ZNSt22__compressed_pair_elemISaIN13StreamNetwork11AcceptQueue7PendingEELi1ELb1EE5__getB7v160000Ev(Larg0){
	return Larg0;
}
function __ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE5beginB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0,tmp2=0,tmp3=null;
	tmp0=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5beginB7v160000Ev(Larg1);
	tmp1=oSlot;
	tmp2=Larg1.i4|0;
	if(__ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5emptyB7v160000Ev(Larg1)|0){
		__ZNSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EEC2B7v160000ES5_S3_(Larg0,tmp0,tmp1+(tmp2>>>9)|0,nullArray,0);
		return;
	}
	tmp3=tmp0[tmp1+(tmp2>>>9)|0];
	__ZNSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EEC2B7v160000ES5_S3_(Larg0,tmp0,tmp1+(tmp2>>>9)|0,tmp3.d,tmp3.o+(tmp2&511)|0);
}
function __ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE3endB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0,tmp2=0,tmp3=null;
	tmp0=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5beginB7v160000Ev(Larg1);
	tmp1=oSlot;
	tmp2=(Larg1.i4|0)+(__ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE4sizeB7v160000Ev(Larg1)|0)|0;
	if(__ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5emptyB7v160000Ev(Larg1)|0){
		__ZNSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EEC2B7v160000ES5_S3_(Larg0,tmp0,tmp1+(tmp2>>>9)|0,nullArray,0);
		return;
	}
	tmp3=tmp0[tmp1+(tmp2>>>9)|0];
	__ZNSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EEC2B7v160000ES5_S3_(Larg0,tmp0,tmp1+(tmp2>>>9)|0,tmp3.d,tmp3.o+(tmp2&511)|0);
}
function __ZStneB7v160000RKSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EES8_(Larg0,Larg1){
	return ((__ZSteqB7v160000RKSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EES8_(Larg0,Larg1)|0)^1?1:0)|0;
}
function __ZNKSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EEdeB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a1;
	tmp1=Larg0.a1o|0;
	return tmp0[tmp1];
}
function __ZNSt16allocator_traitsISaIN13StreamNetwork11AcceptQueue7PendingEEE7destroyB7v160000IS2_vvEEvRS3_PT_(Larg0){
	__ZSt10destroy_atB7v160000IN13StreamNetwork11AcceptQueue7PendingELi0EEvPT_(Larg0);
}
function __ZNSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EEppB7v160000Ev(Larg0){
	var tmp0=0,tmp1=null,tmp2=0,tmp3=null,tmp4=null;
	tmp4=Larg0.a1;
	tmp0=Larg0.a1o|0;
	Larg0.a1=tmp4;
	Larg0.a1o=tmp0+1|0;
	tmp1=Larg0.a0;
	tmp2=Larg0.a0o|0;
	tmp3=tmp1[tmp2];
	if(((__imul(tmp0+1|0,8))-(__imul(tmp3.o,8))|0)===4096){
		Larg0.a0=tmp1;
		Larg0.a0o=tmp2+1|0;
		tmp4=tmp1[tmp2+1|0];
		Larg0.a1=tmp4.d;
		Larg0.a1o=tmp4.o;
	}
	return Larg0;
}
function __ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE6__sizeB7v160000Ev(Larg0){
	oSlot=0;
	return Larg0.a5;
}
function __ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE4sizeB7v160000Ev(Larg0){
	var tmp0=null,tmp1=null;
	tmp0=Larg0.a2[0];
	tmp1=Larg0.a1[0];
	return (__imul(tmp0.o,4))-(__imul(tmp1.o,4))>>2|0;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5frontB7v160000Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1[0];
	oSlot=tmp0.o;
	return tmp0.d;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9pop_frontB7v160000Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1[0];
	__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE19__destruct_at_beginB7v160000EPS3_(Larg0,tmp0.d,tmp0.o+1|0);
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE19__destruct_at_beginB7v160000EPS3_(Larg0,Larg1,Marg1){
	__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE19__destruct_at_beginEPS3_St17integral_constantIbLb1EE(Larg0,Larg1,Marg1);
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE19__destruct_at_beginEPS3_St17integral_constantIbLb1EE(Larg0,Larg1,Marg1){
	Larg1={d:Larg1,o:Marg1};
	Larg0.a1[0]=Larg1;
}
function __ZSt10destroy_atB7v160000IN13StreamNetwork11AcceptQueue7PendingELi0EEvPT_(Larg0){
	__ZSt12__destroy_atB7v160000IN13StreamNetwork11AcceptQueue7PendingELi0EEvPT_(Larg0);
}
function __ZSt12__destroy_atB7v160000IN13StreamNetwork11AcceptQueue7PendingELi0EEvPT_(Larg0){
}
function __ZSteqB7v160000RKSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EES8_(Larg0,Larg1){
	var tmp0=null,tmp1=0,tmp2=null,tmp3=0;
	tmp0=Larg0.a1;
	tmp1=Larg0.a1o|0;
	tmp2=Larg1.a1;
	tmp3=Larg1.a1o|0;
	return (tmp0===tmp2&&tmp1===tmp3?1:0)|0;
}
function __ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE4sizeB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE6__sizeB7v160000Ev(Larg0);
	tmp1=oSlot;
	return tmp0[tmp1]|0;
}
function __ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5emptyB7v160000Ev(Larg0){
	var tmp0=null,tmp1=null;
	tmp0=Larg0.a2[0];
	tmp1=Larg0.a1[0];
	return (tmp0.d===tmp1.d&&tmp0.o===tmp1.o?1:0)|0;
}
function __ZNSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EEC2B7v160000ES5_S3_(Larg0,Larg1,Marg1,Larg2,Marg2){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
	Larg0.a1=Larg2;
	Larg0.a1o=Marg2;
}
function __ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE6__sizeB7v160000Ev(Larg0){
	oSlot=0;
	return Larg0.a5;
}
function __ZNSt12__value_typeIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEE11__get_valueB7v160000Ev(Larg0){
	return Larg0;
}
function __ZNSt17__compressed_pairISt15__tree_end_nodeIPSt16__tree_node_baseIPvEESaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS8_11AcceptQueueEES2_EEE6secondB7v160000Ev(Larg0){
	return __ZNSt22__compressed_pair_elemISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEELi1ELb1EE5__getB7v160000Ev(Larg0);
}
function __ZNSt22__compressed_pair_elemISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEELi1ELb1EE5__getB7v160000Ev(Larg0){
	return Larg0;
}
function __ZNKSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10__end_nodeB7v160000Ev(Larg0){
	return __ZNKSt17__compressed_pairISt15__tree_end_nodeIPSt16__tree_node_baseIPvEESaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS8_11AcceptQueueEES2_EEE5firstB7v160000Ev(Larg0.a1);
}
function __ZNKSt17__compressed_pairISt15__tree_end_nodeIPSt16__tree_node_baseIPvEESaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS8_11AcceptQueueEES2_EEE5firstB7v160000Ev(Larg0){
	return __ZNKSt22__compressed_pair_elemISt15__tree_end_nodeIPSt16__tree_node_baseIPvEELi0ELb0EE5__getB7v160000Ev(Larg0);
}
function __ZNKSt22__compressed_pair_elemISt15__tree_end_nodeIPSt16__tree_node_baseIPvEELi0ELb0EE5__getB7v160000Ev(Larg0){
	return Larg0;
}
function __ZNSt3mapIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueESt4lessIS1_ESaISt4pairIKS1_S2_EEEC2B7v160000Ev(Larg0){
	__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EEC2ERKS8_(Larg0);
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EEC2ERKS8_(Larg0){
	var tmp0=0,tmp1=null;
	__ZNSt17__compressed_pairISt15__tree_end_nodeIPSt16__tree_node_baseIPvEESaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS8_11AcceptQueueEES2_EEEC2B7v160000ILb1EvEEv(Larg0.a1);
	tmp1=[0];
	tmp1[0]=0;
	__ZNSt17__compressed_pairIjSt19__map_value_compareIN13StreamNetwork11ServiceAddrESt12__value_typeIS2_NS1_11AcceptQueueEESt4lessIS2_ELb1EEEC2B7v160000IiRKS8_EEOT_OT0_(Larg0.a2,0,tmp1,0);
	tmp1=__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE12__begin_nodeB7v160000Ev(Larg0);
	tmp0=oSlot;
	tmp1[tmp0]=__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10__end_nodeB7v160000Ev(Larg0);
}
function __ZNSt17__compressed_pairISt15__tree_end_nodeIPSt16__tree_node_baseIPvEESaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS8_11AcceptQueueEES2_EEEC2B7v160000ILb1EvEEv(Larg0){
	__ZNSt22__compressed_pair_elemISt15__tree_end_nodeIPSt16__tree_node_baseIPvEELi0ELb0EEC2B7v160000ESt16__value_init_tag(Larg0);
}
function __ZNSt17__compressed_pairIjSt19__map_value_compareIN13StreamNetwork11ServiceAddrESt12__value_typeIS2_NS1_11AcceptQueueEESt4lessIS2_ELb1EEEC2B7v160000IiRKS8_EEOT_OT0_(Larg0,Marg0,Larg1,Marg1){
	__ZNSt22__compressed_pair_elemIjLi0ELb0EEC2B7v160000IivEEOT_(Larg0,Marg0,Larg1,Marg1);
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10__end_nodeB7v160000Ev(Larg0){
	return __ZNSt17__compressed_pairISt15__tree_end_nodeIPSt16__tree_node_baseIPvEESaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS8_11AcceptQueueEES2_EEE5firstB7v160000Ev(Larg0.a1);
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE12__begin_nodeB7v160000Ev(Larg0){
	oSlot=0;
	return Larg0.a0;
}
function __ZNSt17__compressed_pairISt15__tree_end_nodeIPSt16__tree_node_baseIPvEESaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS8_11AcceptQueueEES2_EEE5firstB7v160000Ev(Larg0){
	return __ZNSt22__compressed_pair_elemISt15__tree_end_nodeIPSt16__tree_node_baseIPvEELi0ELb0EE5__getB7v160000Ev(Larg0);
}
function __ZNSt22__compressed_pair_elemISt15__tree_end_nodeIPSt16__tree_node_baseIPvEELi0ELb0EE5__getB7v160000Ev(Larg0){
	return Larg0;
}
function __ZNSt22__compressed_pair_elemIjLi0ELb0EEC2B7v160000IivEEOT_(Larg0,Marg0,Larg1,Marg1){
	Larg0[Marg0]=Larg1[Marg1]|0;
}
function __ZNSt22__compressed_pair_elemISt15__tree_end_nodeIPSt16__tree_node_baseIPvEELi0ELb0EEC2B7v160000ESt16__value_init_tag(Larg0){
	__ZNSt15__tree_end_nodeIPSt16__tree_node_baseIPvEEC2B7v160000Ev(Larg0);
}
function __ZNSt15__tree_end_nodeIPSt16__tree_node_baseIPvEEC2B7v160000Ev(Larg0){
	Larg0.a0[0]=null;
}
function __ZSt16forward_as_tupleB7v160000IJRN13StreamNetwork11ServiceAddrEEESt5tupleIJDpOT_EES6_(Larg0,Larg1){
	__ZNSt5tupleIJRN13StreamNetwork11ServiceAddrEEEC2B7v160000ISt4_AndLi0EEES2_(Larg0,Larg1);
}
function __ZNSt3mapIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueESt4lessIS1_ESaISt4pairIKS1_S2_EEE7emplaceB7v160000IJRKSt21piecewise_construct_tSt5tupleIJRS1_EESE_IJEEEEES5_ISt14__map_iteratorISt15__tree_iteratorISt12__value_typeIS1_S2_EPSt11__tree_nodeISL_PvElEEbEDpOT_(Larg0,Larg1,Larg2){
	var tmp0=null;
	tmp0={a0:null,i1:0};
	__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE16__emplace_uniqueB7v160000IJRKSt21piecewise_construct_tSt5tupleIJRS2_EESF_IJEEEEESt4pairISt15__tree_iteratorIS4_PSt11__tree_nodeIS4_PvElEbEDpOT_(tmp0,Larg1,Larg2);
	__ZNSt4pairISt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS3_11AcceptQueueEEPSt11__tree_nodeIS6_PvElEEbEC2B7v160000ISB_bLS8_0EEEOS_IT_T0_E(Larg0,tmp0);
}
function __ZSt3getB7v160000ILj0ESt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS3_11AcceptQueueEEPSt11__tree_nodeIS6_PvElEEbEONSt13tuple_elementIXT_ESt4pairIT0_T1_EE4typeEOSH_(Larg0){
	return __ZNSt10__get_pairILj0EE3getB7v160000ISt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS5_11AcceptQueueEEPSt11__tree_nodeIS8_PvElEEbEEOT_OSt4pairISF_T0_E(Larg0);
}
function __ZSt3getB7v160000ILj1ESt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS3_11AcceptQueueEEPSt11__tree_nodeIS6_PvElEEbEONSt13tuple_elementIXT_ESt4pairIT0_T1_EE4typeEOSH_(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSt10__get_pairILj1EE3getB7v160000ISt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS5_11AcceptQueueEEPSt11__tree_nodeIS8_PvElEEbEEOT0_OSt4pairIT_SF_E(Larg0);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function _cheerpCreate_ZN6client23UnderlyingDefaultSourceIPNS_6ObjectEEC2Ev(){
	return new Object();
}
function __ZN6cheerp8CallbackIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS2_22TCPServerSocketOptionsEEUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS2_22TCPServerSocketOptionsEEUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISD_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISD_Efp_EEEOSD_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp8CallbackIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS2_22TCPServerSocketOptionsEEUlvE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS2_22TCPServerSocketOptionsEEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS8_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS8_Efp_EEEOS8_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvvEEcvPN6client13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvvEED2Ev(tmp0);
	return tmp1;
}
function __ZN13StreamNetwork9TCPServerC2EPN6client14ReadableStreamIPNS1_6ObjectEEE(Larg0,Larg1){
	var tmp0=null;
	Larg0.a0=Larg1;
	Larg0.a1=__ZN6client20PromiseWithResolversIPNS_4_AnyEE6createEv();
	tmp0={a0:null};
	tmp0.a0=Larg0;
	Larg0.a2=__ZN6cheerp8CallbackIZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS3_6ObjectEEEEUlvE_EEPNS3_13EventListenerEOT_(tmp0);
}
function __ZN13StreamNetwork19makeTCPServerSocketEPNS_9TCPServerEPKN6client6StringEj(Larg0,Larg1,Larg2){
	var tmp0=null,tmp1=null;
	tmp0=Promise.resolve({readable :Larg0.a0, localAddress :Larg1, localPort :Larg2});
	tmp1=Larg0.a1.promise;
	return {opened :tmp0, closed :tmp1, close :Larg0.a2};
}
function __ZN6cheerp8CallbackIZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS3_6ObjectEEEEUlvE_EEPNS3_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS3_6ObjectEEEEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISA_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISA_Efp_EEEOSA_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS3_6ObjectEEEEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISA_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISA_Efp_EEEOSA_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS3_6ObjectEEEEUlvE_MS9_KFPNS3_7PromiseIPNS3_4_AnyEEEvEE12make_closureEOS9_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS3_6ObjectEEEEUlvE_MS9_KFPNS3_7PromiseIPNS3_4_AnyEEEvEE12make_closureEOS9_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEEC2IZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISI_PS7_EE5valueEvE4typeEPNSL_IXntsrNS8_13_must_destroyISI_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEEC2IZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISI_PS7_EE5valueEvE4typeEPNSL_IXntsrNS8_13_must_destroyISI_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_JEEES6_PT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_JEEES6_PT_DpT0_(Larg0){
	return __ZZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS1_6ObjectEEEENKUlvE_clEv(Larg0);
}
function __ZZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS1_6ObjectEEEENKUlvE_clEv(Larg0){
	var L$poptgepsqueezed8=null,tmp1=null,tmp2=null,tmp3=null;
	tmp1=Larg0.a0;
	tmp2=create__ZZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS1_6ObjectEEEENKUlvE_clEv$pFrame({a0:null,a1:null,a2:tmp2={a0:null},a3:null,a4:tmp2={a0:null,a1:null,a2:nullArray},i5:0,a6:tmp2={i0:0},a7:tmp2={i0:0}}).a;
	tmp3=tmp2[0];
	tmp3.a0=__ZZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS1_6ObjectEEEENKUlvE_clEv$presume;
	tmp3.a1=__ZZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS1_6ObjectEEEENKUlvE_clEv$pdestroy;
	tmp3.a3=tmp1;
	tmp1=__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS0_14ReadableStreamIPNS0_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEv(tmp3.a2);
	L$poptgepsqueezed8=tmp3.a4;
	__ZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed8,tmp3.a3.a0.cancel());
	tmp3.i5=1;
	tmp3={a0:nullArray,a0o:0};
	__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_EE12promise_typeEE12from_addressB7v160000EPv(tmp3,tmp2,0);
	tmp2={a0:nullArray,a0o:0};
	__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(tmp2,tmp3);
	__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed8,tmp2);
	return tmp1;
}
function __ZZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS1_6ObjectEEEENKUlvE_clEv$presume(Larg0,Marg0){
	var L$poptgepsqueezed6=null,tmp1=null,tmp2=null;
	L$poptgepsqueezed6=Larg0[Marg0].a4;
	if((Larg0[Marg0].i5&3)!==0){
		__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed6);
		Larg0[Marg0].a3.a1.resolve.call(null,null);
		__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS0_14ReadableStreamIPNS0_6ObjectEEEEUlvE_EE12promise_type12return_valueES3_(Larg0[Marg0].a2);
	}else{
		__ZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed6,Larg0[Marg0].a3.a0.cancel());
		Larg0[Marg0].i5=1;
		tmp1={a0:nullArray,a0o:0};
		__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_EE12promise_typeEE12from_addressB7v160000EPv(tmp1,Larg0,Marg0);
		tmp2={a0:nullArray,a0o:0};
		__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(tmp2,tmp1);
		__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed6,tmp2);
	}
}
function __ZZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS1_6ObjectEEEENKUlvE_clEv$pdestroy(Larg0,Marg0){
	Larg0=Larg0[Marg0];
	var tmp0=0;
	tmp0=Larg0.i5|0;
	if(Larg0.a0!==null)if((tmp0&3)!==0)__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0.a4);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS0_14ReadableStreamIPNS0_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEv(Larg0){
	var tmp0=null;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	return new Promise(_cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRKZN13StreamNetwork9TCPServerC1EPNS_14ReadableStreamIPNS_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(tmp0));
}
function __ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_EE12promise_typeEE12from_addressB7v160000EPv(Larg0,Larg1,Marg1){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_EE12promise_typeEE7addressB7v160000Ev(Larg1);
	tmp1=oSlot;
	__ZNSt16coroutine_handleIvE12from_addressB7v160000EPv(Larg0,tmp0,tmp1);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS0_14ReadableStreamIPNS0_6ObjectEEEEUlvE_EE12promise_type12return_valueES3_(Larg0){
	Larg0.a0.call(null,null);
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_EE12promise_typeEE7addressB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	oSlot=tmp1;
	return tmp0;
}
function _cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRKZN13StreamNetwork9TCPServerC1EPNS_14ReadableStreamIPNS_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(Larg0){
	return __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS2_14ReadableStreamIPNS2_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0);
}
function __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS2_14ReadableStreamIPNS2_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS2_14ReadableStreamIPNS2_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISO_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISO_Efp_EEEOSO_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client8FunctionEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS2_14ReadableStreamIPNS2_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISO_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISO_Efp_EEEOSO_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS2_14ReadableStreamIPNS2_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSM_KFvSL_EE12make_closureESN_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS2_14ReadableStreamIPNS2_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSM_KFvSL_EE12make_closureESN_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISR_PS4_EE5valueEvE4typeEPNSU_IXntsrNS5_13_must_destroyISR_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS1_14ReadableStreamIPNS1_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISR_PS4_EE5valueEvE4typeEPNSU_IXntsrNS5_13_must_destroyISR_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS4_14ReadableStreamIPNS4_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSN_EEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS4_14ReadableStreamIPNS4_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSN_EEEvPT_DpT0_(Larg0,Larg1){
	__ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS0_14ReadableStreamIPNS0_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESJ_(Larg0,Larg1);
}
function __ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork9TCPServerC1EPNS0_14ReadableStreamIPNS0_6ObjectEEEEUlvE_EE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESJ_(Larg0,Larg1){
	Larg0.a0.a0=Larg1;
}
function __ZN6cheerp12make_closureIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS2_22TCPServerSocketOptionsEEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS8_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS8_Efp_EEEOS8_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS2_22TCPServerSocketOptionsEEUlvE_MS7_KFvvEE12make_closureEOS7_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS2_22TCPServerSocketOptionsEEUlvE_MS7_KFvvEE12make_closureEOS7_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvvEEC2IZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS5_22TCPServerSocketOptionsEEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISB_PS1_EE5valueEvE4typeEPNSE_IXntsrNS2_13_must_destroyISB_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvvEEC2IZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS5_22TCPServerSocketOptionsEEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISB_PS1_EE5valueEvE4typeEPNSE_IXntsrNS2_13_must_destroyISB_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null,a1:{a0:null}}];
	tmp0[0].a0=Larg1.a0;
	tmp0[0].a1.a0=Larg1.a1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS4_22TCPServerSocketOptionsEEUlvE_JEEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS4_22TCPServerSocketOptionsEEUlvE_JEEEvPT_DpT0_(Larg0){
	__ZZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsEENKUlvE_clEv(Larg0);
}
function __ZZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsEENKUlvE_clEv(Larg0){
	var tmp0=null,tmp1=null,L$poptgepsqueezed=null;
	tmp0=Larg0.a0;
	L$poptgepsqueezed=Larg0.a1;
	__ZN13StreamNetwork11AcceptQueue4pushEPN6client6ObjectEPNS1_8FunctionE(__ZNKSt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEEptB7v160000Ev(L$poptgepsqueezed).a2,null,null);
	L$poptgepsqueezed=L$poptgepsqueezed.a0;
	tmp1={a0:null};
	tmp1.a0=L$poptgepsqueezed;
	L$poptgepsqueezed={a0:null};
	__ZNSt3mapIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueESt4lessIS1_ESaISt4pairIKS1_S2_EEE5eraseB7v160000ESt14__map_iteratorISt15__tree_iteratorISt12__value_typeIS1_S2_EPSt11__tree_nodeISD_PvElEE(L$poptgepsqueezed,tmp0,tmp1);
}
function __ZNKSt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEEptB7v160000Ev(Larg0){
	return __ZNSt12__value_typeIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEE11__get_valueB7v160000Ev(__ZNKSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEptB7v160000Ev(Larg0));
}
function __ZN13StreamNetwork11AcceptQueue4pushEPN6client6ObjectEPNS1_8FunctionE(Larg0,Larg1,Larg2){
	var tmp0=null;
	tmp0={a0:null,a1:null};
	if(__ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE8isActiveEv(Larg0)|0){
		tmp0.a0=Larg1;
		tmp0.a1=Larg2;
		__ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE6resumeES2_(Larg0,tmp0);
	}else{
		tmp0.a0=Larg1;
		tmp0.a1=Larg2;
		__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE9push_backEOS2_(Larg0.a3,tmp0);
	}
}
function __ZNSt3mapIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueESt4lessIS1_ESaISt4pairIKS1_S2_EEE5eraseB7v160000ESt14__map_iteratorISt15__tree_iteratorISt12__value_typeIS1_S2_EPSt11__tree_nodeISD_PvElEE(Larg0,Larg1,Larg2){
	var tmp0=null,L$psroa$p0$p0$pcopyload=null;
	L$psroa$p0$p0$pcopyload=Larg2.a0;
	tmp0={a0:null};
	tmp0.a0=L$psroa$p0$p0$pcopyload;
	L$psroa$p0$p0$pcopyload={a0:null};
	__ZNSt21__tree_const_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEC2B7v160000ESt15__tree_iteratorIS4_S8_lE(L$psroa$p0$p0$pcopyload,tmp0);
	__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE5eraseESt21__tree_const_iteratorIS4_PSt11__tree_nodeIS4_PvElE(tmp0,Larg1,L$psroa$p0$p0$pcopyload);
	__ZNSt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEEC2B7v160000ESA_(Larg0,tmp0);
}
function __ZNSt21__tree_const_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEC2B7v160000ESt15__tree_iteratorIS4_S8_lE(Larg0,Larg1){
	Larg0.a0=Larg1.a0;
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE5eraseESt21__tree_const_iteratorIS4_PSt11__tree_nodeIS4_PvElE(Larg0,Larg1,Larg2){
	__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE21__remove_node_pointerEPSt11__tree_nodeIS4_PvE(Larg0,Larg1,__ZNKSt21__tree_const_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElE8__get_npB7v160000Ev(Larg2));
	__ZNSt16allocator_traitsISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEEE7destroyB7v160000ISt4pairIKS3_S4_EvvEEvRS8_PT_(__ZNSt22__tree_key_value_typesISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEE9__get_ptrB7v160000ERS4_(__ZNKSt21__tree_const_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEdeB7v160000Ev(Larg2)));
}
function __ZNSt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEEC2B7v160000ESA_(Larg0,Larg1){
	Larg0.a0=Larg1.a0;
}
function __ZNKSt21__tree_const_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElE8__get_npB7v160000Ev(Larg0){
	return Larg0.a0;
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE21__remove_node_pointerEPSt11__tree_nodeIS4_PvE(Larg0,Larg1,Larg2){
	var tmp0=null,tmp1=0;
	__ZNSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEC2B7v160000ES8_(Larg0,Larg2);
	__ZNSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEppB7v160000Ev(Larg0);
	tmp0=__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE12__begin_nodeB7v160000Ev(Larg1);
	tmp1=oSlot;
	if(tmp0[tmp1]===Larg2)tmp0[tmp1]=Larg0.a0;
	tmp0=__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE4sizeB7v160000Ev(Larg1);
	tmp1=oSlot;
	tmp0[tmp1]=(tmp0[tmp1]|0)-1|0;
	__ZSt13__tree_removeB7v160000IPSt16__tree_node_baseIPvEEvT_S4_(__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10__end_nodeB7v160000Ev(Larg1).a0[0],Larg2);
}
function __ZNKSt21__tree_const_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEdeB7v160000Ev(Larg0){
	return __ZNKSt21__tree_const_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElE8__get_npB7v160000Ev(Larg0).a4;
}
function __ZNSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEC2B7v160000ES8_(Larg0,Larg1){
	Larg0.a0=Larg1;
}
function __ZNSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEppB7v160000Ev(Larg0){
	Larg0.a0=__ZSt16__tree_next_iterB7v160000IPSt15__tree_end_nodeIPSt16__tree_node_baseIPvEES4_ET_T0_(Larg0.a0);
	return Larg0;
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE4sizeB7v160000Ev(Larg0){
	oSlot=0;
	return Larg0.a2;
}
function __ZSt13__tree_removeB7v160000IPSt16__tree_node_baseIPvEEvT_S4_(Larg0,Larg1){
	var tmp0=0,tmp1=null,tmp2=null,L$ppre$mphi=null,L$pnot2237=0,L$pbe=null,L$plcssa57=null,tmp7=null;
	tmp1=Larg1.a0[0];
	if(tmp1!==null){
		if(Larg1.a1[0]!==null){
			tmp2=__ZSt11__tree_nextB7v160000IPSt16__tree_node_baseIPvEET_S4_(Larg1);
			L$ppre$mphi=tmp2;
			tmp1=tmp2.a0[0];
		}else{
			L$ppre$mphi=Larg1;
			tmp2=Larg1;
		}
	}else{
		L$ppre$mphi=Larg1;
		tmp2=Larg1;
		tmp1=null;
	}
	a:{
		if(tmp1===null){
			tmp1=tmp2.a1[0];
			if(tmp1===null){
				tmp1=null;
				L$pnot2237=1;
				break a;
			}
		}
		tmp1.a2=tmp2.a2;
		L$pnot2237=0;
	}
	if(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(tmp2)|0){
		tmp2.a2.a0[0]=tmp1;
		if(tmp2===Larg0){
			L$plcssa57=tmp1;
			L$pbe=null;
		}else{
			L$pbe=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(tmp2).a1[0];
			L$plcssa57=Larg0;
		}
	}else{
		__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(tmp2).a1[0]=tmp1;
		L$pbe=tmp2.a2.a0[0];
		L$plcssa57=Larg0;
	}
	tmp0=tmp2.i3|0;
	if(tmp2!==Larg1){
		tmp7=Larg1.a2;
		tmp2.a2=tmp7;
		if(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(Larg1)|0)tmp7.a0[0]=tmp2;
		else __ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(tmp2).a1[0]=tmp2;
		tmp7=Larg1.a0[0];
		L$ppre$mphi.a0[0]=tmp7;
		__ZNSt16__tree_node_baseIPvE12__set_parentB7v160000EPS1_(tmp7,tmp2);
		L$ppre$mphi=Larg1.a1[0];
		tmp2.a1[0]=L$ppre$mphi;
		if(L$ppre$mphi!==null)__ZNSt16__tree_node_baseIPvE12__set_parentB7v160000EPS1_(L$ppre$mphi,tmp2);
		tmp2.i3=Larg1.i3&1;
		L$plcssa57=(L$plcssa57===Larg1?tmp2:L$plcssa57);
	}
	a:if((tmp0&1)!==0)if(L$plcssa57!==null)if(L$pnot2237)while(1){
		L$pnot2237=L$pbe.i3|0;
		{
			if(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(L$pbe)|0){
				if((L$pnot2237&1)===0){
					L$pbe.i3=1;
					__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe).i3=0;
					__ZSt19__tree_right_rotateB7v160000IPSt16__tree_node_baseIPvEEvT_(__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe));
					tmp1=L$pbe.a1[0];
					L$plcssa57=(L$plcssa57===tmp1?L$pbe:L$plcssa57);
					L$pbe=tmp1.a0[0];
				}
				tmp1=L$pbe.a0[0];
				L$pnot2237=tmp1===null?1:0;
				b:{
					if(!(L$pnot2237))if((tmp1.i3&1)===0)break b;
					L$ppre$mphi=L$pbe.a1[0];
					if(L$ppre$mphi!==null)if((L$ppre$mphi.i3&1)===0){
						if(!(L$pnot2237))if((tmp1.i3&1)===0)break b;
						L$ppre$mphi.i3=1;
						L$pbe.i3=0;
						__ZSt18__tree_left_rotateB7v160000IPSt16__tree_node_baseIPvEEvT_(L$pbe);
						L$pbe=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe);
						break b;
					}
					L$pbe.i3=0;
					L$pbe=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe);
					if((L$pbe.i3&1)!==0)if(L$pbe!==L$plcssa57){
						if(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(L$pbe)|0){
							L$pbe=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe).a1[0];
							continue;
						}
						L$pbe=L$pbe.a2.a0[0];
						continue;
					}
					L$pbe.i3=1;
					break a;
				}
				L$pbe.i3=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe).i3&1;
				__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe).i3=1;
				L$pbe.a0[0].i3=1;
				__ZSt19__tree_right_rotateB7v160000IPSt16__tree_node_baseIPvEEvT_(__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe));
				break a;
			}
			if((L$pnot2237&1)===0){
				L$pbe.i3=1;
				__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe).i3=0;
				__ZSt18__tree_left_rotateB7v160000IPSt16__tree_node_baseIPvEEvT_(__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe));
				tmp1=L$pbe.a0[0];
				L$plcssa57=(L$plcssa57===tmp1?L$pbe:L$plcssa57);
				L$pbe=tmp1.a1[0];
			}
			tmp1=L$pbe.a0[0];
			b:{
				c:{
					d:{
						if(tmp1!==null)if((tmp1.i3&1)===0){
							L$plcssa57=L$pbe.a1[0];
							if(L$plcssa57===null)break c;
							L$pnot2237=L$plcssa57.i3|0;
							L$pnot2237&=1;
							break d;
						}
						L$ppre$mphi=L$pbe.a1[0];
						if(L$ppre$mphi!==null){
							L$pnot2237=L$ppre$mphi.i3&1;
							if(L$pnot2237===0)break d;
						}
						L$pbe.i3=0;
						L$pbe=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe);
						if(L$pbe!==L$plcssa57){
							if((L$pbe.i3&1)!==0){
								if(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(L$pbe)|0){
									L$pbe=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe).a1[0];
									continue;
								}
								L$pbe=L$pbe.a2.a0[0];
								continue;
							}
							L$plcssa57=L$pbe;
						}
						L$plcssa57.i3=1;
						break a;
					}
					if(L$pnot2237===0)break b;
				}
				tmp1.i3=1;
				L$pbe.i3=0;
				__ZSt19__tree_right_rotateB7v160000IPSt16__tree_node_baseIPvEEvT_(L$pbe);
				L$pbe=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe);
			}
			L$pbe.i3=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe).i3&1;
			__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe).i3=1;
			L$pbe.a1[0].i3=1;
			__ZSt18__tree_left_rotateB7v160000IPSt16__tree_node_baseIPvEEvT_(__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$pbe));
			break a;
		}
		continue;
	}
	else tmp1.i3=1;
}
function __ZSt11__tree_nextB7v160000IPSt16__tree_node_baseIPvEET_S4_(Larg0){
	var L$plcssa=null;
	L$plcssa=Larg0.a1[0];
	if(L$plcssa!==null)return __ZSt10__tree_minB7v160000IPSt16__tree_node_baseIPvEET_S4_(L$plcssa);
	if(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(Larg0)|0){
		L$plcssa=Larg0;
	}else{
		L$plcssa=Larg0;
		while(1){
			L$plcssa=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$plcssa);
			if(!(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(L$plcssa)|0))continue;
			break;
		}
	}
	return __ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$plcssa);
}
function __ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(Larg0){
	return (Larg0.a2.a0[0]===Larg0?1:0)|0;
}
function __ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(Larg0){
	return Larg0.a2;
}
function __ZNSt16__tree_node_baseIPvE12__set_parentB7v160000EPS1_(Larg0,Larg1){
	Larg0.a2=Larg1;
}
function __ZSt18__tree_left_rotateB7v160000IPSt16__tree_node_baseIPvEEvT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0=Larg0.a1[0];
	tmp1=tmp0.a0[0];
	Larg0.a1[0]=tmp1;
	if(tmp1!==null)__ZNSt16__tree_node_baseIPvE12__set_parentB7v160000EPS1_(tmp1,Larg0);
	tmp0.a2=Larg0.a2;
	if(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(Larg0)|0)Larg0.a2.a0[0]=tmp0;
	else __ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(Larg0).a1[0]=tmp0;
	tmp0.a0[0]=Larg0;
	__ZNSt16__tree_node_baseIPvE12__set_parentB7v160000EPS1_(Larg0,tmp0);
}
function __ZSt19__tree_right_rotateB7v160000IPSt16__tree_node_baseIPvEEvT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0=Larg0.a0[0];
	tmp1=tmp0.a1[0];
	Larg0.a0[0]=tmp1;
	if(tmp1!==null)__ZNSt16__tree_node_baseIPvE12__set_parentB7v160000EPS1_(tmp1,Larg0);
	tmp0.a2=Larg0.a2;
	if(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(Larg0)|0)Larg0.a2.a0[0]=tmp0;
	else __ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(Larg0).a1[0]=tmp0;
	tmp0.a1[0]=Larg0;
	__ZNSt16__tree_node_baseIPvE12__set_parentB7v160000EPS1_(Larg0,tmp0);
}
function __ZSt10__tree_minB7v160000IPSt16__tree_node_baseIPvEET_S4_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0=Larg0;
	while(1){
		tmp1=tmp0.a0[0];
		if(tmp1!==null){
			tmp0=tmp1;
			continue;
		}
		break;
	}
	return tmp0;
}
function __ZSt16__tree_next_iterB7v160000IPSt15__tree_end_nodeIPSt16__tree_node_baseIPvEES4_ET_T0_(Larg0){
	var L$plcssa=null;
	L$plcssa=Larg0.a1[0];
	if(L$plcssa!==null)return __ZSt10__tree_minB7v160000IPSt16__tree_node_baseIPvEET_S4_(L$plcssa);
	if(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(Larg0)|0){
		L$plcssa=Larg0;
	}else{
		L$plcssa=Larg0;
		while(1){
			L$plcssa=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(L$plcssa);
			if(!(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(L$plcssa)|0))continue;
			break;
		}
	}
	return L$plcssa.a2;
}
function __ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE8isActiveEv(Larg0){
	var L$psroa$p0$p0$pcopyload_0=null,tmp1=null,tmp2=null,L$psroa$p0$p0$pcopyload_1=0;
	L$psroa$p0$p0$pcopyload_0=Larg0.a0;
	L$psroa$p0$p0$pcopyload_1=Larg0.a0o|0;
	tmp1={a0:nullArray,a0o:0};
	__ZNSt16coroutine_handleIvEC2B7v160000EDn(tmp1);
	tmp2={a0:nullArray,a0o:0};
	tmp2.a0=L$psroa$p0$p0$pcopyload_0;
	tmp2.a0o=L$psroa$p0$p0$pcopyload_1;
	L$psroa$p0$p0$pcopyload_1=__ZSteqB7v160000St16coroutine_handleIvES0_(tmp2,tmp1)|0;
	return (L$psroa$p0$p0$pcopyload_1^1?1:0)|0;
}
function __ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE6resumeES2_(Larg0,Larg1){
	var tmp0=null,tmp1=0,tmp2=null;
	__ZNSt8optionalIN13StreamNetwork11AcceptQueue7PendingEEaSB7v160000IS2_vEERS3_OT_(Larg0.a1,Larg1);
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	tmp2={a0:nullArray,a0o:0};
	tmp2.a0=tmp0;
	tmp2.a0o=tmp1;
	__ZNSt16coroutine_handleIvEaSB7v160000EDn(Larg0);
	Larg0.a2=null;
	__ZNKSt16coroutine_handleIvE6resumeB7v160000Ev(tmp2);
}
function __ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE9push_backEOS2_(Larg0,Larg1){
	var tmp0=0,tmp1=null;
	if(((__ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE12__back_spareB7v160000Ev(Larg0)|0)|0)===0)__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE19__add_back_capacityEv(Larg0);
	tmp1={a0:nullArray,a0o:0,a1:nullArray,a1o:0};
	__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE3endB7v160000Ev(tmp1,Larg0);
	__ZNSt16allocator_traitsISaIN13StreamNetwork11AcceptQueue7PendingEEE9constructB7v160000IS2_JS2_EvvEEvRS3_PT_DpOT0_(__ZNKSt16__deque_iteratorIN13StreamNetwork11AcceptQueue7PendingEPS2_RS2_PS3_lLl512EEdeB7v160000Ev(tmp1),Larg1);
	tmp1=__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE6__sizeB7v160000Ev(Larg0);
	tmp0=oSlot;
	tmp1[tmp0]=(tmp1[tmp0]|0)+1|0;
}
function __ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE12__back_spareB7v160000Ev(Larg0){
	return (__ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE10__capacityB7v160000Ev(Larg0)|0)-((Larg0.i4|0)+(__ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE4sizeB7v160000Ev(Larg0)|0)|0)|0;
}
function __ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE19__add_back_capacityEv(Larg0){
	var tmp0=null,tmp1=0,tmp2=null,tmp3=0,Lgeptoindexphi=0,LmergedArray=null,tmp6=null,tmp7=null;
	tmp2=__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE7__allocB7v160000Ev(Larg0);
	tmp0=[nullObj];
	if((__ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE13__front_spareB7v160000Ev(Larg0)|0)>>>0>511){
		Larg0.i4=(Larg0.i4|0)-512|0;
		tmp2=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5frontB7v160000Ev(Larg0);
		tmp3=oSlot;
		tmp2=tmp2[tmp3];
		tmp0[0]=tmp2;
		__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9pop_frontB7v160000Ev(Larg0);
		__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9push_backB7v160000ERKS3_(Larg0,tmp0,0);
	}else{
		tmp3=__ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE4sizeB7v160000Ev(Larg0)|0;
		Lgeptoindexphi=__ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE8capacityB7v160000Ev(Larg0)|0;
		if(tmp3>>>0<Lgeptoindexphi>>>0){
			tmp3=__ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE12__back_spareB7v160000Ev(Larg0)|0;
			tmp2=__ZNSt16allocator_traitsISaIN13StreamNetwork11AcceptQueue7PendingEEE8allocateB7v160000ERS3_j();
			Lgeptoindexphi=oSlot;
			if((tmp3|0)!==0){
				tmp0[0]={d:tmp2,o:Lgeptoindexphi};
				__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9push_backEOS3_(Larg0,tmp0,0);
			}else{
				tmp0[0]={d:tmp2,o:Lgeptoindexphi};
				__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE10push_frontEOS3_(Larg0,tmp0,0);
				tmp2=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5frontB7v160000Ev(Larg0);
				tmp3=oSlot;
				tmp2=tmp2[tmp3];
				tmp0[0]=tmp2;
				__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9pop_frontB7v160000Ev(Larg0);
				__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9push_backB7v160000ERKS3_(Larg0,tmp0,0);
			}
		}else{
			LmergedArray=new Int32Array(2);
			LmergedArray[0]=Lgeptoindexphi<<1;
			LmergedArray[1]=1;
			tmp6=__ZSt3maxB7v160000IjERKT_S2_S2_(LmergedArray,0,LmergedArray,1);
			Lgeptoindexphi=oSlot;
			LmergedArray={a0:[nullObj],a1:[nullObj],a2:[nullObj],a3:{a0:[nullObj],a1:{a0:null}}};
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EEC2EjjS5_(LmergedArray,tmp6[Lgeptoindexphi]|0,tmp3,__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE7__allocB7v160000Ev(Larg0));
			tmp6=__ZNSt16allocator_traitsISaIN13StreamNetwork11AcceptQueue7PendingEEE8allocateB7v160000ERS3_j();
			tmp3=oSlot;
			tmp7={a0:null,i1:0};
			__ZNSt22__allocator_destructorISaIN13StreamNetwork11AcceptQueue7PendingEEEC2B7v160000ERS3_j(tmp7,tmp2);
			tmp2={a0:[nullObj],a1:{a0:null,i1:0}};
			__ZNSt10unique_ptrIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEEC2B7v160000ILb1EvEES3_NSt16__dependent_typeISt27__unique_ptr_deleter_sfinaeIS6_EXT_EE20__good_rval_ref_typeE(tmp2,tmp6,tmp3,tmp7);
			tmp6=__ZNKSt10unique_ptrIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEE3getB7v160000Ev(tmp2);
			tmp3=oSlot;
			tmp0[0]={d:tmp6,o:tmp3};
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE9push_backEOS3_(LmergedArray,tmp0,0);
			__ZNSt10unique_ptrIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEE7releaseB7v160000Ev(tmp2);
			tmp6=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE3endB7v160000Ev(Larg0);
			tmp3=oSlot;
			tmp7=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5beginB7v160000Ev(Larg0);
			Lgeptoindexphi=oSlot;
			if(tmp6!==tmp7||tmp3!==Lgeptoindexphi){
				Lgeptoindexphi=0;
				while(1){
					Lgeptoindexphi=Lgeptoindexphi-1|0;
					__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE10push_frontERKS3_(LmergedArray,tmp6,tmp3+Lgeptoindexphi|0);
					tmp7=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5beginB7v160000Ev(Larg0);
					tmp1=oSlot;
					if(tmp6!==tmp7||(tmp3+Lgeptoindexphi|0)!==tmp1)continue;
					break;
				}
			}
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a0,0,LmergedArray.a0,0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a1,0,LmergedArray.a1,0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a2,0,LmergedArray.a2,0);
			tmp6=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9__end_capB7v160000Ev(Larg0);
			tmp3=oSlot;
			tmp7=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE9__end_capB7v160000Ev(LmergedArray);
			Lgeptoindexphi=oSlot;
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(tmp6,tmp3,tmp7,Lgeptoindexphi);
			__ZNSt10unique_ptrIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEED2B7v160000Ev(tmp2);
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EED2Ev(LmergedArray);
		}
	}
}
function __ZNSt16allocator_traitsISaIN13StreamNetwork11AcceptQueue7PendingEEE9constructB7v160000IS2_JS2_EvvEEvRS3_PT_DpOT0_(Larg0,Larg1){
	__ZSt12construct_atB7v160000IN13StreamNetwork11AcceptQueue7PendingEJS2_EPS2_EPT_S5_DpOT0_(Larg0,Larg1);
}
function __ZSt12construct_atB7v160000IN13StreamNetwork11AcceptQueue7PendingEJS2_EPS2_EPT_S5_DpOT0_(Larg0,Larg1){
	Larg0.a0=Larg1.a0;
	Larg0.a1=Larg1.a1;
	return Larg0;
}
function __ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE13__front_spareB7v160000Ev(Larg0){
	return Larg0.i4|0;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9push_backB7v160000ERKS3_(Larg0,Larg1,Marg1){
	var tmp0=null,L$ppre=null,tmp2=0,LmergedArray=null,tmp4=null,L$pneg=0,tmp6=null;
	tmp0=Larg0.a2[0];
	L$ppre=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9__end_capB7v160000Ev(Larg0);
	tmp2=oSlot;
	LmergedArray=L$ppre[tmp2];
	if(tmp0.d===LmergedArray.d&&tmp0.o===LmergedArray.o){
		LmergedArray=Larg0.a1[0];
		tmp4=Larg0.a0[0];
		L$pneg=(__imul(tmp4.o,4));
		if(LmergedArray.o>tmp4.o){
			L$pneg=(((__imul(LmergedArray.o,4))-L$pneg>>2)+1|0)/-2|0;
			L$ppre=__ZSt4moveB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_ET0_T_S6_S5_(LmergedArray.d,LmergedArray.o,tmp0.d,tmp0.o,LmergedArray.d,LmergedArray.o+L$pneg|0);
			tmp2=oSlot;
			Larg0.a2[0]={d:L$ppre,o:tmp2};
			tmp0=Larg0.a1[0];
			Larg0.a1[0]={d:tmp0.d,o:tmp0.o+L$pneg|0};
		}else{
			LmergedArray=new Int32Array(2);
			LmergedArray[0]=(__imul(tmp0.o,4))-L$pneg>>1;
			LmergedArray[1]=1;
			tmp0=__ZSt3maxB7v160000IjERKT_S2_S2_(LmergedArray,0,LmergedArray,1);
			L$pneg=oSlot;
			L$pneg=tmp0[L$pneg]|0;
			tmp0={a0:[nullObj],a1:[nullObj],a2:[nullObj],a3:{a0:[nullObj],a1:{a0:null}}};
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EEC2EjjS5_(tmp0,L$pneg,L$pneg>>>2,__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE7__allocB7v160000Ev(Larg0));
			tmp6=Larg0.a1[0];
			LmergedArray={a0:[nullObj]};
			__ZNSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEC2B7v160000ES4_(LmergedArray,tmp6.d,tmp6.o);
			tmp6=Larg0.a2[0];
			tmp4={a0:[nullObj]};
			__ZNSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEC2B7v160000ES4_(tmp4,tmp6.d,tmp6.o);
			tmp6={a0:[nullObj]};
			LmergedArray=LmergedArray.a0[0];
			tmp6.a0[0]=LmergedArray;
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE18__construct_at_endISt13move_iteratorIPS3_EEENSt9enable_ifIXsr27__is_cpp17_forward_iteratorIT_EE5valueEvE4typeESC_SC_(tmp0,tmp6,tmp4);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a0,0,tmp0.a0,0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a1,0,tmp0.a1,0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a2,0,tmp0.a2,0);
			LmergedArray=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE9__end_capB7v160000Ev(tmp0);
			L$pneg=oSlot;
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(L$ppre,tmp2,LmergedArray,L$pneg);
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EED2Ev(tmp0);
			L$ppre=Larg0.a2[0];
			tmp2=L$ppre.o;
			L$ppre=L$ppre.d;
		}
	}else{
		L$ppre=tmp0.d;
		tmp2=tmp0.o;
	}
	__ZNSt16allocator_traitsISaIPN13StreamNetwork11AcceptQueue7PendingEEE9constructB7v160000IS3_JRKS3_EvvEEvRS4_PT_DpOT0_(L$ppre,tmp2,Larg1,Marg1);
	tmp0=Larg0.a2[0];
	Larg0.a2[0]={d:tmp0.d,o:tmp0.o+1|0};
}
function __ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE12__back_spareB7v160000Ev(Larg0){
	var tmp0=0,tmp1=null,tmp2=null;
	tmp2=__ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9__end_capB7v160000Ev(Larg0);
	tmp0=oSlot;
	tmp2=tmp2[tmp0];
	tmp1=Larg0.a2[0];
	return (__imul(tmp2.o,4))-(__imul(tmp1.o,4))>>2|0;
}
function __ZNSt16allocator_traitsISaIN13StreamNetwork11AcceptQueue7PendingEEE8allocateB7v160000ERS3_j(){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSaIN13StreamNetwork11AcceptQueue7PendingEE8allocateB7v160000Ej();
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9push_backEOS3_(Larg0,Larg1,Marg1){
	var tmp0=null,L$ppre=null,tmp2=0,LmergedArray=null,tmp4=null,L$pneg=0,tmp6=null;
	tmp0=Larg0.a2[0];
	L$ppre=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9__end_capB7v160000Ev(Larg0);
	tmp2=oSlot;
	LmergedArray=L$ppre[tmp2];
	if(tmp0.d===LmergedArray.d&&tmp0.o===LmergedArray.o){
		LmergedArray=Larg0.a1[0];
		tmp4=Larg0.a0[0];
		L$pneg=(__imul(tmp4.o,4));
		if(LmergedArray.o>tmp4.o){
			L$pneg=(((__imul(LmergedArray.o,4))-L$pneg>>2)+1|0)/-2|0;
			L$ppre=__ZSt4moveB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_ET0_T_S6_S5_(LmergedArray.d,LmergedArray.o,tmp0.d,tmp0.o,LmergedArray.d,LmergedArray.o+L$pneg|0);
			tmp2=oSlot;
			Larg0.a2[0]={d:L$ppre,o:tmp2};
			tmp0=Larg0.a1[0];
			Larg0.a1[0]={d:tmp0.d,o:tmp0.o+L$pneg|0};
		}else{
			LmergedArray=new Int32Array(2);
			LmergedArray[0]=(__imul(tmp0.o,4))-L$pneg>>1;
			LmergedArray[1]=1;
			tmp0=__ZSt3maxB7v160000IjERKT_S2_S2_(LmergedArray,0,LmergedArray,1);
			L$pneg=oSlot;
			L$pneg=tmp0[L$pneg]|0;
			tmp0={a0:[nullObj],a1:[nullObj],a2:[nullObj],a3:{a0:[nullObj],a1:{a0:null}}};
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EEC2EjjS5_(tmp0,L$pneg,L$pneg>>>2,__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE7__allocB7v160000Ev(Larg0));
			tmp6=Larg0.a1[0];
			LmergedArray={a0:[nullObj]};
			__ZNSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEC2B7v160000ES4_(LmergedArray,tmp6.d,tmp6.o);
			tmp6=Larg0.a2[0];
			tmp4={a0:[nullObj]};
			__ZNSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEC2B7v160000ES4_(tmp4,tmp6.d,tmp6.o);
			tmp6={a0:[nullObj]};
			LmergedArray=LmergedArray.a0[0];
			tmp6.a0[0]=LmergedArray;
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE18__construct_at_endISt13move_iteratorIPS3_EEENSt9enable_ifIXsr27__is_cpp17_forward_iteratorIT_EE5valueEvE4typeESC_SC_(tmp0,tmp6,tmp4);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a0,0,tmp0.a0,0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a1,0,tmp0.a1,0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a2,0,tmp0.a2,0);
			LmergedArray=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE9__end_capB7v160000Ev(tmp0);
			L$pneg=oSlot;
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(L$ppre,tmp2,LmergedArray,L$pneg);
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EED2Ev(tmp0);
			L$ppre=Larg0.a2[0];
			tmp2=L$ppre.o;
			L$ppre=L$ppre.d;
		}
	}else{
		L$ppre=tmp0.d;
		tmp2=tmp0.o;
	}
	__ZNSt16allocator_traitsISaIPN13StreamNetwork11AcceptQueue7PendingEEE9constructB7v160000IS3_JS3_EvvEEvRS4_PT_DpOT0_(L$ppre,tmp2,Larg1,Marg1);
	tmp0=Larg0.a2[0];
	Larg0.a2[0]={d:tmp0.d,o:tmp0.o+1|0};
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE10push_frontEOS3_(Larg0,Larg1,Marg1){
	var tmp0=null,LmergedArray=null,L$ppre=null,tmp3=0,tmp4=null,tmp5=0,tmp6=null;
	tmp0=Larg0.a1[0];
	LmergedArray=Larg0.a0[0];
	if(tmp0.d===LmergedArray.d&&tmp0.o===LmergedArray.o){
		LmergedArray=Larg0.a2[0];
		L$ppre=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9__end_capB7v160000Ev(Larg0);
		tmp3=oSlot;
		tmp4=L$ppre[tmp3];
		if(LmergedArray.o<tmp4.o){
			tmp5=(((__imul(tmp4.o,4))-(__imul(LmergedArray.o,4))>>2)+1|0)/2|0;
			L$ppre=__ZSt13move_backwardB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_ET0_T_S6_S5_(tmp0.d,tmp0.o,LmergedArray.d,LmergedArray.o,LmergedArray.d,LmergedArray.o+tmp5|0);
			tmp3=oSlot;
			Larg0.a1[0]={d:L$ppre,o:tmp3};
			tmp0=Larg0.a2[0];
			Larg0.a2[0]={d:tmp0.d,o:tmp0.o+tmp5|0};
		}else{
			LmergedArray=new Int32Array(2);
			LmergedArray[0]=(__imul(tmp4.o,4))-(__imul(tmp0.o,4))>>1;
			LmergedArray[1]=1;
			tmp4=__ZSt3maxB7v160000IjERKT_S2_S2_(LmergedArray,0,LmergedArray,1);
			tmp5=oSlot;
			tmp5=tmp4[tmp5]|0;
			LmergedArray={a0:[nullObj],a1:[nullObj],a2:[nullObj],a3:{a0:[nullObj],a1:{a0:null}}};
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EEC2EjjS5_(LmergedArray,tmp5,tmp5+3>>>2,__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE7__allocB7v160000Ev(Larg0));
			tmp6=Larg0.a1[0];
			tmp4={a0:[nullObj]};
			__ZNSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEC2B7v160000ES4_(tmp4,tmp6.d,tmp6.o);
			tmp6=Larg0.a2[0];
			tmp0={a0:[nullObj]};
			__ZNSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEC2B7v160000ES4_(tmp0,tmp6.d,tmp6.o);
			tmp6={a0:[nullObj]};
			tmp4=tmp4.a0[0];
			tmp6.a0[0]=tmp4;
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE18__construct_at_endISt13move_iteratorIPS3_EEENSt9enable_ifIXsr27__is_cpp17_forward_iteratorIT_EE5valueEvE4typeESC_SC_(LmergedArray,tmp6,tmp0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a0,0,LmergedArray.a0,0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a1,0,LmergedArray.a1,0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a2,0,LmergedArray.a2,0);
			tmp4=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE9__end_capB7v160000Ev(LmergedArray);
			tmp5=oSlot;
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(L$ppre,tmp3,tmp4,tmp5);
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EED2Ev(LmergedArray);
			L$ppre=Larg0.a1[0];
			tmp3=L$ppre.o;
			L$ppre=L$ppre.d;
		}
	}else{
		L$ppre=tmp0.d;
		tmp3=tmp0.o;
	}
	__ZNSt16allocator_traitsISaIPN13StreamNetwork11AcceptQueue7PendingEEE9constructB7v160000IS3_JS3_EvvEEvRS4_PT_DpOT0_(L$ppre,tmp3+ -1|0,Larg1,Marg1);
	LmergedArray=Larg0.a1[0];
	Larg0.a1[0]={d:LmergedArray.d,o:LmergedArray.o+ -1|0};
}
function __ZSt3maxB7v160000IjERKT_S2_S2_(Larg0,Marg0,Larg1,Marg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZSt3maxB7v160000IjSt6__lessIjjEERKT_S4_S4_T0_(Larg0,Marg0,Larg1,Marg1);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EEC2EjjS5_(Larg0,Larg1,Larg2,Larg3){
	var tmp0=0,tmp1=0,tmp2=null,L$psink_0=null,L$psink_1=0;
	__ZNSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EEC2B7v160000IDnS6_EEOT_OT0_(Larg0.a3,Larg3);
	if((Larg1|0)!==0){
		tmp2={a0:nullArray,a0o:0,i1:0};
		__ZSt19__allocate_at_leastB7v160000ISaIPN13StreamNetwork11AcceptQueue7PendingEEESt19__allocation_resultINSt16allocator_traitsIT_E7pointerEERS7_j(tmp2,Larg1);
		L$psink_0=tmp2.a0;
		L$psink_1=tmp2.a0o|0;
		tmp0=tmp2.i1|0;
	}else{
		tmp0=0;
		L$psink_1=0;
		L$psink_0=nullArray;
	}
	Larg0.a0[0]={d:L$psink_0,o:L$psink_1};
	Larg0.a2[0]={d:L$psink_0,o:L$psink_1+Larg2|0};
	Larg0.a1[0]={d:L$psink_0,o:L$psink_1+Larg2|0};
	tmp2=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE9__end_capB7v160000Ev(Larg0);
	tmp1=oSlot;
	tmp2[tmp1]={d:L$psink_0,o:L$psink_1+tmp0|0};
}
function __ZNSt22__allocator_destructorISaIN13StreamNetwork11AcceptQueue7PendingEEEC2B7v160000ERS3_j(Larg0,Larg1){
	Larg0.a0=Larg1;
	Larg0.i1=512;
}
function __ZNSt10unique_ptrIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEEC2B7v160000ILb1EvEES3_NSt16__dependent_typeISt27__unique_ptr_deleter_sfinaeIS6_EXT_EE20__good_rval_ref_typeE(Larg0,Larg1,Marg1,Larg2){
	Larg1={d:Larg1,o:Marg1};
	var tmp0=null;
	tmp0=[nullObj];
	tmp0[0]=Larg1;
	__ZNSt17__compressed_pairIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEEC2B7v160000IRS3_S6_EEOT_OT0_(Larg0,tmp0,0,Larg2);
}
function __ZNKSt10unique_ptrIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEE3getB7v160000Ev(Larg0){
	var tmp0=0,tmp1=null;
	tmp1=__ZNKSt17__compressed_pairIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEE5firstB7v160000Ev(Larg0);
	tmp0=oSlot;
	tmp1=tmp1[tmp0];
	oSlot=tmp1.o;
	return tmp1.d;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE9push_backEOS3_(Larg0,Larg1,Marg1){
	var tmp0=null,L$ppre=null,tmp2=0,LmergedArray=null,tmp4=null,L$pneg=0,tmp6=null;
	tmp0=Larg0.a2[0];
	L$ppre=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE9__end_capB7v160000Ev(Larg0);
	tmp2=oSlot;
	LmergedArray=L$ppre[tmp2];
	if(tmp0.d===LmergedArray.d&&tmp0.o===LmergedArray.o){
		LmergedArray=Larg0.a1[0];
		tmp4=Larg0.a0[0];
		L$pneg=(__imul(tmp4.o,4));
		if(LmergedArray.o>tmp4.o){
			L$pneg=(((__imul(LmergedArray.o,4))-L$pneg>>2)+1|0)/-2|0;
			L$ppre=__ZSt4moveB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_ET0_T_S6_S5_(LmergedArray.d,LmergedArray.o,tmp0.d,tmp0.o,LmergedArray.d,LmergedArray.o+L$pneg|0);
			tmp2=oSlot;
			Larg0.a2[0]={d:L$ppre,o:tmp2};
			tmp0=Larg0.a1[0];
			Larg0.a1[0]={d:tmp0.d,o:tmp0.o+L$pneg|0};
		}else{
			LmergedArray=new Int32Array(2);
			LmergedArray[0]=(__imul(tmp0.o,4))-L$pneg>>1;
			LmergedArray[1]=1;
			tmp0=__ZSt3maxB7v160000IjERKT_S2_S2_(LmergedArray,0,LmergedArray,1);
			L$pneg=oSlot;
			L$pneg=tmp0[L$pneg]|0;
			tmp0={a0:[nullObj],a1:[nullObj],a2:[nullObj],a3:{a0:[nullObj],a1:{a0:null}}};
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EEC2EjjS5_(tmp0,L$pneg,L$pneg>>>2,__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE7__allocB7v160000Ev(Larg0));
			tmp6=Larg0.a1[0];
			LmergedArray={a0:[nullObj]};
			__ZNSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEC2B7v160000ES4_(LmergedArray,tmp6.d,tmp6.o);
			tmp6=Larg0.a2[0];
			tmp4={a0:[nullObj]};
			__ZNSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEC2B7v160000ES4_(tmp4,tmp6.d,tmp6.o);
			tmp6={a0:[nullObj]};
			LmergedArray=LmergedArray.a0[0];
			tmp6.a0[0]=LmergedArray;
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE18__construct_at_endISt13move_iteratorIPS3_EEENSt9enable_ifIXsr27__is_cpp17_forward_iteratorIT_EE5valueEvE4typeESC_SC_(tmp0,tmp6,tmp4);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a0,0,tmp0.a0,0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a1,0,tmp0.a1,0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a2,0,tmp0.a2,0);
			LmergedArray=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE9__end_capB7v160000Ev(tmp0);
			L$pneg=oSlot;
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(L$ppre,tmp2,LmergedArray,L$pneg);
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EED2Ev(tmp0);
			L$ppre=Larg0.a2[0];
			tmp2=L$ppre.o;
			L$ppre=L$ppre.d;
		}
	}else{
		L$ppre=tmp0.d;
		tmp2=tmp0.o;
	}
	__ZNSt16allocator_traitsISaIPN13StreamNetwork11AcceptQueue7PendingEEE9constructB7v160000IS3_JS3_EvvEEvRS4_PT_DpOT0_(L$ppre,tmp2,Larg1,Marg1);
	tmp0=Larg0.a2[0];
	Larg0.a2[0]={d:tmp0.d,o:tmp0.o+1|0};
}
function __ZNSt10unique_ptrIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEE7releaseB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSt17__compressed_pairIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEE5firstB7v160000Ev(Larg0);
	tmp1=oSlot;
	tmp0[tmp1]=nullObj;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE10push_frontERKS3_(Larg0,Larg1,Marg1){
	var tmp0=null,LmergedArray=null,L$ppre=null,tmp3=0,tmp4=null,tmp5=0,tmp6=null;
	tmp0=Larg0.a1[0];
	LmergedArray=Larg0.a0[0];
	if(tmp0.d===LmergedArray.d&&tmp0.o===LmergedArray.o){
		LmergedArray=Larg0.a2[0];
		L$ppre=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE9__end_capB7v160000Ev(Larg0);
		tmp3=oSlot;
		tmp4=L$ppre[tmp3];
		if(LmergedArray.o<tmp4.o){
			tmp5=(((__imul(tmp4.o,4))-(__imul(LmergedArray.o,4))>>2)+1|0)/2|0;
			L$ppre=__ZSt13move_backwardB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_ET0_T_S6_S5_(tmp0.d,tmp0.o,LmergedArray.d,LmergedArray.o,LmergedArray.d,LmergedArray.o+tmp5|0);
			tmp3=oSlot;
			Larg0.a1[0]={d:L$ppre,o:tmp3};
			tmp0=Larg0.a2[0];
			Larg0.a2[0]={d:tmp0.d,o:tmp0.o+tmp5|0};
		}else{
			LmergedArray=new Int32Array(2);
			LmergedArray[0]=(__imul(tmp4.o,4))-(__imul(tmp0.o,4))>>1;
			LmergedArray[1]=1;
			tmp4=__ZSt3maxB7v160000IjERKT_S2_S2_(LmergedArray,0,LmergedArray,1);
			tmp5=oSlot;
			tmp5=tmp4[tmp5]|0;
			LmergedArray={a0:[nullObj],a1:[nullObj],a2:[nullObj],a3:{a0:[nullObj],a1:{a0:null}}};
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EEC2EjjS5_(LmergedArray,tmp5,tmp5+3>>>2,__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE7__allocB7v160000Ev(Larg0));
			tmp6=Larg0.a1[0];
			tmp4={a0:[nullObj]};
			__ZNSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEC2B7v160000ES4_(tmp4,tmp6.d,tmp6.o);
			tmp6=Larg0.a2[0];
			tmp0={a0:[nullObj]};
			__ZNSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEC2B7v160000ES4_(tmp0,tmp6.d,tmp6.o);
			tmp6={a0:[nullObj]};
			tmp4=tmp4.a0[0];
			tmp6.a0[0]=tmp4;
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE18__construct_at_endISt13move_iteratorIPS3_EEENSt9enable_ifIXsr27__is_cpp17_forward_iteratorIT_EE5valueEvE4typeESC_SC_(LmergedArray,tmp6,tmp0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a0,0,LmergedArray.a0,0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a1,0,LmergedArray.a1,0);
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0.a2,0,LmergedArray.a2,0);
			tmp4=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE9__end_capB7v160000Ev(LmergedArray);
			tmp5=oSlot;
			__ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(L$ppre,tmp3,tmp4,tmp5);
			__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EED2Ev(LmergedArray);
			L$ppre=Larg0.a1[0];
			tmp3=L$ppre.o;
			L$ppre=L$ppre.d;
		}
	}else{
		L$ppre=tmp0.d;
		tmp3=tmp0.o;
	}
	__ZNSt16allocator_traitsISaIPN13StreamNetwork11AcceptQueue7PendingEEE9constructB7v160000IS3_JRKS3_EvvEEvRS4_PT_DpOT0_(L$ppre,tmp3+ -1|0,Larg1,Marg1);
	LmergedArray=Larg0.a1[0];
	Larg0.a1[0]={d:LmergedArray.d,o:LmergedArray.o+ -1|0};
}
function __ZSt4swapB7v160000IPPN13StreamNetwork11AcceptQueue7PendingEENSt9enable_ifIXaasr21is_move_constructibleIT_EE5valuesr18is_move_assignableIS6_EE5valueEvE4typeERS6_S9_(Larg0,Marg0,Larg1,Marg1){
	var tmp0=null,tmp1=null;
	tmp0=Larg0[Marg0];
	tmp1=Larg1[Marg1];
	Larg0[Marg0]=tmp1;
	Larg1[Marg1]=tmp0;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9__end_capB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5firstB7v160000Ev(Larg0.a3);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE9__end_capB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE5firstB7v160000Ev(Larg0.a3);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNSt10unique_ptrIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEED2B7v160000Ev(Larg0){
	__ZNSt10unique_ptrIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEE5resetB7v160000ES3_(Larg0);
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EED2Ev(Larg0){
	__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE5clearB7v160000Ev(Larg0);
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE5clearB7v160000Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1[0];
	__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE17__destruct_at_endB7v160000EPS3_(Larg0,tmp0.d,tmp0.o);
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE7__allocB7v160000Ev(Larg0){
	return __ZNSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE6secondB7v160000Ev(Larg0.a3);
}
function __ZNSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE6secondB7v160000Ev(Larg0){
	return __ZNSt22__compressed_pair_elemIRSaIPN13StreamNetwork11AcceptQueue7PendingEELi1ELb0EE5__getB7v160000Ev(Larg0.a1);
}
function __ZNSt22__compressed_pair_elemIRSaIPN13StreamNetwork11AcceptQueue7PendingEELi1ELb0EE5__getB7v160000Ev(Larg0){
	return Larg0.a0;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE17__destruct_at_endB7v160000EPS3_(Larg0,Larg1,Marg1){
	__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE17__destruct_at_endB7v160000EPS3_St17integral_constantIbLb0EE(Larg0,Larg1,Marg1);
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE17__destruct_at_endB7v160000EPS3_St17integral_constantIbLb0EE(Larg0,Larg1,Marg1){
	var tmp0=null,Lgeptoindexphi=0;
	tmp0=Larg0.a2[0];
	if(tmp0.d!==Larg1||tmp0.o!==Marg1){
		Lgeptoindexphi=0;
		while(1){
			Lgeptoindexphi=Lgeptoindexphi-1|0;
			__ZNSt16allocator_traitsISaIPN13StreamNetwork11AcceptQueue7PendingEEE7destroyB7v160000IS3_vvEEvRS4_PT_(tmp0.d[tmp0.o+Lgeptoindexphi|0]);
			if(tmp0.d!==Larg1||(tmp0.o+Lgeptoindexphi|0)!==Marg1)continue;
			break;
		}
		Larg0.a2[0]={d:tmp0.d,o:tmp0.o+Lgeptoindexphi|0};
	}
}
function __ZNSt10unique_ptrIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEE5resetB7v160000ES3_(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSt17__compressed_pairIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEE5firstB7v160000Ev(Larg0);
	tmp1=oSlot;
	tmp0[tmp1]=nullObj;
}
function __ZNSt17__compressed_pairIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEE5firstB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSt22__compressed_pair_elemIPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EE5__getB7v160000Ev(Larg0);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNSt22__compressed_pair_elemIPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EE5__getB7v160000Ev(Larg0){
	oSlot=0;
	return Larg0.a0;
}
function __ZNSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE5firstB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSt22__compressed_pair_elemIPPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EE5__getB7v160000Ev(Larg0);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNSt22__compressed_pair_elemIPPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EE5__getB7v160000Ev(Larg0){
	oSlot=0;
	return Larg0.a0;
}
function __ZNSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5firstB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSt22__compressed_pair_elemIPPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EE5__getB7v160000Ev(Larg0);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZSt13move_backwardB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_ET0_T_S6_S5_(Larg0,Marg0,Larg1,Marg1,Larg2,Marg2){
	var tmp0=null,tmp1=0;
	tmp0=__ZSt15__move_backwardB7v160000ISt17_ClassicAlgPolicyPPN13StreamNetwork11AcceptQueue7PendingES5_ET1_T0_S7_S6_(Larg0,Marg0,Larg1,Marg1,Larg2,Marg2);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEC2B7v160000ES4_(Larg0,Larg1,Marg1){
	Larg1={d:Larg1,o:Marg1};
	Larg0.a0[0]=Larg1;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE18__construct_at_endISt13move_iteratorIPS3_EEENSt9enable_ifIXsr27__is_cpp17_forward_iteratorIT_EE5valueEvE4typeESC_SC_(Larg0,Larg1,Larg2){
	var L$ppromoted_1=0,tmp1=null,tmp2=0,L$psroa$p03$p0$pcopyload=null,L$psroa$p0$p0$pcopyload=null,L$ppromoted_0=null,tmp6=0,Lgeptoindexphi=0;
	L$psroa$p03$p0$pcopyload=Larg1.a0[0];
	L$psroa$p0$p0$pcopyload=Larg2.a0[0];
	L$ppromoted_0={a0:[nullObj]};
	L$ppromoted_0.a0[0]=L$psroa$p03$p0$pcopyload;
	L$psroa$p03$p0$pcopyload={a0:[nullObj]};
	L$psroa$p03$p0$pcopyload.a0[0]=L$psroa$p0$p0$pcopyload;
	tmp6=__ZSt8distanceB7v160000ISt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEENSt15iterator_traitsIT_E15difference_typeES8_S8_(L$ppromoted_0,L$psroa$p03$p0$pcopyload)|0;
	L$psroa$p03$p0$pcopyload={a0:nullArray,a0o:0,a1:nullArray,a1o:0,a2:nullArray,a2o:0};
	__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE21_ConstructTransactionC2B7v160000EPPS3_j(L$psroa$p03$p0$pcopyload,Larg0.a2,0,tmp6);
	L$psroa$p0$p0$pcopyload=L$psroa$p03$p0$pcopyload.a1;
	tmp6=L$psroa$p03$p0$pcopyload.a1o|0;
	L$ppromoted_0=L$psroa$p03$p0$pcopyload.a0;
	L$ppromoted_1=L$psroa$p03$p0$pcopyload.a0o|0;
	if(L$ppromoted_0!==L$psroa$p0$p0$pcopyload||L$ppromoted_1!==tmp6){
		Lgeptoindexphi=0;
		while(1){
			tmp1=__ZNKSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEdeB7v160000Ev(Larg1);
			tmp2=oSlot;
			__ZNSt16allocator_traitsISaIPN13StreamNetwork11AcceptQueue7PendingEEE9constructB7v160000IS3_JS3_EvvEEvRS4_PT_DpOT0_(L$ppromoted_0,L$ppromoted_1+Lgeptoindexphi|0,tmp1,tmp2);
			Lgeptoindexphi=Lgeptoindexphi+1|0;
			__ZNSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEppB7v160000Ev(Larg1);
			if(L$ppromoted_0!==L$psroa$p0$p0$pcopyload||(L$ppromoted_1+Lgeptoindexphi|0)!==tmp6)continue;
			break;
		}
	}
	L$psroa$p03$p0$pcopyload.a0=L$psroa$p0$p0$pcopyload;
	L$psroa$p03$p0$pcopyload.a0o=tmp6;
	__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE21_ConstructTransactionD2B7v160000Ev(L$psroa$p03$p0$pcopyload);
}
function __ZNSt16allocator_traitsISaIPN13StreamNetwork11AcceptQueue7PendingEEE9constructB7v160000IS3_JRKS3_EvvEEvRS4_PT_DpOT0_(Larg0,Marg0,Larg1,Marg1){
	__ZSt12construct_atB7v160000IPN13StreamNetwork11AcceptQueue7PendingEJRKS3_EPS3_EPT_S8_DpOT0_(Larg0,Marg0,Larg1,Marg1);
}
function __ZSt12construct_atB7v160000IPN13StreamNetwork11AcceptQueue7PendingEJRKS3_EPS3_EPT_S8_DpOT0_(Larg0,Marg0,Larg1,Marg1){
	var tmp0=null;
	tmp0=Larg1[Marg1];
	Larg0[Marg0]=tmp0;
	return Larg0[Marg0];
}
function __ZSt8distanceB7v160000ISt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEENSt15iterator_traitsIT_E15difference_typeES8_S8_(Larg0,Larg1){
	var L$psroa$p01$p0$pcopyload=null,tmp1=null,tmp2=0,L$psroa$p04$p0$pcopyload=null;
	L$psroa$p04$p0$pcopyload=Larg0.a0[0];
	L$psroa$p01$p0$pcopyload=Larg1.a0[0];
	tmp1={a0:[nullObj]};
	tmp1.a0[0]=L$psroa$p04$p0$pcopyload;
	L$psroa$p04$p0$pcopyload={a0:[nullObj]};
	L$psroa$p04$p0$pcopyload.a0[0]=L$psroa$p01$p0$pcopyload;
	tmp2=__ZSt10__distanceB7v160000ISt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEENSt15iterator_traitsIT_E15difference_typeES8_S8_St26random_access_iterator_tag(tmp1,L$psroa$p04$p0$pcopyload)|0;
	return tmp2|0;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE21_ConstructTransactionC2B7v160000EPPS3_j(Larg0,Larg1,Marg1,Larg2){
	var tmp0=null;
	tmp0=Larg1[Marg1];
	Larg0.a0=tmp0.d;
	Larg0.a0o=tmp0.o;
	tmp0=Larg1[Marg1];
	Larg0.a1=tmp0.d;
	Larg0.a1o=tmp0.o+Larg2|0;
	Larg0.a2=Larg1;
	Larg0.a2o=Marg1;
}
function __ZNKSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEdeB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt6ranges11__iter_move4__fnclB7v160000IRKPPN13StreamNetwork11AcceptQueue7PendingEEEDTclsr3stdE4movedeclsr3stdE7forwardIT_Efp_EEEOSA_(Larg0.a0,0);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNSt16allocator_traitsISaIPN13StreamNetwork11AcceptQueue7PendingEEE9constructB7v160000IS3_JS3_EvvEEvRS4_PT_DpOT0_(Larg0,Marg0,Larg1,Marg1){
	__ZSt12construct_atB7v160000IPN13StreamNetwork11AcceptQueue7PendingEJS3_EPS3_EPT_S6_DpOT0_(Larg0,Marg0,Larg1,Marg1);
}
function __ZNSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEppB7v160000Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a0[0];
	Larg0.a0[0]={d:tmp0.d,o:tmp0.o+1|0};
	return Larg0;
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EE21_ConstructTransactionD2B7v160000Ev(Larg0){
	var tmp0=null,tmp1=0,tmp2=null,tmp3=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	tmp2=Larg0.a2;
	tmp3=Larg0.a2o|0;
	tmp2[tmp3]={d:tmp0,o:tmp1};
}
function __ZSt12construct_atB7v160000IPN13StreamNetwork11AcceptQueue7PendingEJS3_EPS3_EPT_S6_DpOT0_(Larg0,Marg0,Larg1,Marg1){
	var tmp0=null;
	tmp0=Larg1[Marg1];
	Larg0[Marg0]=tmp0;
	return Larg0[Marg0];
}
function __ZNKSt6ranges11__iter_move4__fnclB7v160000IRKPPN13StreamNetwork11AcceptQueue7PendingEEEDTclsr3stdE4movedeclsr3stdE7forwardIT_Efp_EEEOSA_(Larg0,Marg0){
	var tmp0=null;
	tmp0=Larg0[Marg0];
	oSlot=tmp0.o;
	return tmp0.d;
}
function __ZSt10__distanceB7v160000ISt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEEENSt15iterator_traitsIT_E15difference_typeES8_S8_St26random_access_iterator_tag(Larg0,Larg1){
	return (__ZStmiB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_EDTmicldtfp_4baseEcldtfp0_4baseEERKSt13move_iteratorIT_ERKS6_IT0_E(Larg1,Larg0)|0)|0;
}
function __ZStmiB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_EDTmicldtfp_4baseEcldtfp0_4baseEERKSt13move_iteratorIT_ERKS6_IT0_E(Larg0,Larg1){
	var tmp0=null,tmp1=0,tmp2=null;
	tmp0=__ZNKRSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEE4baseB7v160000Ev(Larg0);
	tmp1=oSlot;
	tmp0=tmp0[tmp1];
	tmp2=__ZNKRSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEE4baseB7v160000Ev(Larg1);
	tmp1=oSlot;
	tmp2=tmp2[tmp1];
	return (__imul(tmp0.o,4))-(__imul(tmp2.o,4))>>2|0;
}
function __ZNKRSt13move_iteratorIPPN13StreamNetwork11AcceptQueue7PendingEE4baseB7v160000Ev(Larg0){
	oSlot=0;
	return Larg0.a0;
}
function __ZSt15__move_backwardB7v160000ISt17_ClassicAlgPolicyPPN13StreamNetwork11AcceptQueue7PendingES5_ET1_T0_S7_S6_(Larg0,Marg0,Larg1,Marg1,Larg2,Marg2){
	var tmp0=null,tmp1=0,tmp2=null,tmp3=0;
	tmp0=__ZSt20__move_backward_implB7v160000ISt17_ClassicAlgPolicyPN13StreamNetwork11AcceptQueue7PendingES4_ENSt9enable_ifIXaasr7is_sameIu14__remove_constIT0_ET1_EE5valuesr28is_trivially_move_assignableIS8_EE5valueEPS8_E4typeEPS6_SC_S9_(Larg0,Marg0,Larg1,Marg1,Larg2,Marg2);
	tmp1=oSlot;
	tmp2=__ZSt13__rewrap_iterB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_St18__unwrap_iter_implIS4_Lb1EEET_S7_T0_(Larg2,Marg2,tmp0,tmp1);
	tmp3=oSlot;
	oSlot=tmp3;
	return tmp2;
}
function __ZSt20__move_backward_implB7v160000ISt17_ClassicAlgPolicyPN13StreamNetwork11AcceptQueue7PendingES4_ENSt9enable_ifIXaasr7is_sameIu14__remove_constIT0_ET1_EE5valuesr28is_trivially_move_assignableIS8_EE5valueEPS8_E4typeEPS6_SC_S9_(Larg0,Marg0,Larg1,Marg1,Larg2,Marg2){
	var tmp0=0,Lgeptoindexphi1=0,Lgeptoindexphi5=0,Lgeptoindex20=0,tmp4=0,Lxtraiter=0,tmp6=null,Lprol$piter=0;
	Lgeptoindexphi1=(__imul(Marg0,4));
	Lgeptoindexphi5=(__imul(Marg1,4));
	if((Lgeptoindexphi5|0)===(Lgeptoindexphi1|0)){
		oSlot=Marg2;
		return Larg2;
	}
	Lgeptoindexphi1=Lgeptoindexphi5-Lgeptoindexphi1|0;
	tmp0=-(Lgeptoindexphi1>>2)|0;
	if(Lgeptoindexphi1>>>0<4){
		oSlot=Marg2+tmp0|0;
		return Larg2;
	}
	Lgeptoindexphi5=Lgeptoindexphi1>>>2;
	Lgeptoindex20=tmp0+Lgeptoindexphi5|0;
	if((Marg2+tmp0|0)>Marg0){
		tmp4=Lgeptoindexphi1-4|0;
		Lgeptoindexphi1=(tmp4>>>2)+1&3;
		if((Lgeptoindexphi1|0)!==0){
			Lxtraiter=0;
			while(1){
				Lgeptoindexphi5=Lgeptoindexphi5-1|0;
				tmp6=Larg0[Marg0+Lgeptoindexphi5|0];
				Lgeptoindex20=Lgeptoindex20-1|0;
				Larg2[Marg2+Lgeptoindex20|0]=tmp6;
				Lxtraiter=Lxtraiter+1|0;
				if((Lxtraiter|0)!==(Lgeptoindexphi1|0))continue;
				break;
			}
		}
		if(tmp4>>>0<12){
			oSlot=Marg2+tmp0|0;
			return Larg2;
		}
		while(1){
			tmp6=Larg0[(Marg0+Lgeptoindexphi5|0)+ -1|0];
			Larg2[(Marg2+Lgeptoindex20|0)+ -1|0]=tmp6;
			tmp6=Larg0[(Marg0+Lgeptoindexphi5|0)+ -2|0];
			Larg2[(Marg2+Lgeptoindex20|0)+ -2|0]=tmp6;
			tmp6=Larg0[(Marg0+Lgeptoindexphi5|0)+ -3|0];
			Larg2[(Marg2+Lgeptoindex20|0)+ -3|0]=tmp6;
			Lgeptoindexphi5=Lgeptoindexphi5-4|0;
			tmp6=Larg0[Marg0+Lgeptoindexphi5|0];
			Lgeptoindex20=Lgeptoindex20-4|0;
			Larg2[Marg2+Lgeptoindex20|0]=tmp6;
			if(Larg2!==Larg2||(Marg2+tmp0|0)!==(Marg2+Lgeptoindex20|0))continue;
			break;
		}
		oSlot=Marg2+tmp0|0;
		return Larg2;
	}else{
		tmp4=Lgeptoindexphi1-4|0;
		Lxtraiter=(tmp4>>>2)+1&7;
		if((Lxtraiter|0)!==0){
			Lgeptoindexphi5=tmp0;
			Lprol$piter=0;
			Lgeptoindexphi1=0;
			while(1){
				tmp6=Larg0[Marg0+Lgeptoindexphi1|0];
				Larg2[Marg2+Lgeptoindexphi5|0]=tmp6;
				Lprol$piter=Lprol$piter+1|0;
				Lgeptoindexphi5=Lgeptoindexphi5+1|0;
				Lgeptoindexphi1=Lgeptoindexphi1+1|0;
				if((Lprol$piter|0)!==(Lxtraiter|0))continue;
				break;
			}
		}else{
			Lgeptoindexphi5=tmp0;
			Lgeptoindexphi1=0;
		}
		if(tmp4>>>0<28){
			oSlot=Marg2+tmp0|0;
			return Larg2;
		}
		while(1){
			tmp6=Larg0[Marg0+Lgeptoindexphi1|0];
			Larg2[Marg2+Lgeptoindexphi5|0]=tmp6;
			tmp6=Larg0[(Marg0+Lgeptoindexphi1|0)+1|0];
			Larg2[(Marg2+Lgeptoindexphi5|0)+1|0]=tmp6;
			tmp6=Larg0[(Marg0+Lgeptoindexphi1|0)+2|0];
			Larg2[(Marg2+Lgeptoindexphi5|0)+2|0]=tmp6;
			tmp6=Larg0[(Marg0+Lgeptoindexphi1|0)+3|0];
			Larg2[(Marg2+Lgeptoindexphi5|0)+3|0]=tmp6;
			tmp6=Larg0[(Marg0+Lgeptoindexphi1|0)+4|0];
			Larg2[(Marg2+Lgeptoindexphi5|0)+4|0]=tmp6;
			tmp6=Larg0[(Marg0+Lgeptoindexphi1|0)+5|0];
			Larg2[(Marg2+Lgeptoindexphi5|0)+5|0]=tmp6;
			tmp6=Larg0[(Marg0+Lgeptoindexphi1|0)+6|0];
			Larg2[(Marg2+Lgeptoindexphi5|0)+6|0]=tmp6;
			tmp6=Larg0[(Marg0+Lgeptoindexphi1|0)+7|0];
			Larg2[(Marg2+Lgeptoindexphi5|0)+7|0]=tmp6;
			Lgeptoindexphi5=Lgeptoindexphi5+8|0;
			if(Larg2===Larg2&&(Marg2+Lgeptoindex20|0)===(Marg2+Lgeptoindexphi5|0)){
				oSlot=Marg2+tmp0|0;
				return Larg2;
			}
			Lgeptoindexphi1=Lgeptoindexphi1+8|0;
			continue;
		}
	}
}
function __ZSt13__rewrap_iterB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_St18__unwrap_iter_implIS4_Lb1EEET_S7_T0_(Larg0,Marg0,Larg1,Marg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSt18__unwrap_iter_implIPPN13StreamNetwork11AcceptQueue7PendingELb1EE8__rewrapB7v160000ES4_S4_(Larg0,Marg0,Larg1,Marg1);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNSt18__unwrap_iter_implIPPN13StreamNetwork11AcceptQueue7PendingELb1EE8__rewrapB7v160000ES4_S4_(Larg0,Marg0,Larg1,Marg1){
	oSlot=Marg0+((__imul(Marg1,4))-(__imul(Marg0,4))>>2)|0;
	return Larg0;
}
function __ZSt4moveB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_ET0_T_S6_S5_(Larg0,Marg0,Larg1,Marg1,Larg2,Marg2){
	var tmp0=null,tmp1=null,tmp2=0;
	tmp0={a0:nullArray,a0o:0,a1:nullArray,a1o:0};
	__ZSt6__moveB7v160000ISt17_ClassicAlgPolicyPPN13StreamNetwork11AcceptQueue7PendingES5_S5_ENSt9enable_ifIXaaaasr21is_copy_constructibleIT0_EE5valuesr21is_copy_constructibleIT1_EE5valuesr21is_copy_constructibleIT2_EE5valueESt4pairIS7_S9_EE4typeES7_S8_S9_(tmp0,Larg0,Marg0,Larg1,Marg1,Larg2,Marg2);
	tmp1=tmp0.a1;
	tmp2=tmp0.a1o|0;
	oSlot=tmp2;
	return tmp1;
}
function __ZSt6__moveB7v160000ISt17_ClassicAlgPolicyPPN13StreamNetwork11AcceptQueue7PendingES5_S5_ENSt9enable_ifIXaaaasr21is_copy_constructibleIT0_EE5valuesr21is_copy_constructibleIT1_EE5valuesr21is_copy_constructibleIT2_EE5valueESt4pairIS7_S9_EE4typeES7_S8_S9_(Larg0,Larg1,Marg1,Larg2,Marg2,Larg3,Marg3){
	var tmp0=null,LmergedArray=null,tmp2=0,tmp3=null,tmp4=0;
	tmp0={a0:nullArray,a0o:0,a1:nullArray,a1o:0};
	__ZSt11__move_implB7v160000ISt17_ClassicAlgPolicyPN13StreamNetwork11AcceptQueue7PendingES4_vESt4pairIPT0_PT1_ES7_S7_S9_(tmp0,Larg1,Marg1,Larg2,Marg2,Larg3,Marg3);
	LmergedArray=tmp0.a0;
	tmp2=tmp0.a0o|0;
	tmp3=__ZSt13__rewrap_iterB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_St18__unwrap_iter_implIS4_Lb1EEET_S7_T0_(Larg1,Marg1,LmergedArray,tmp2);
	tmp4=oSlot;
	LmergedArray=[nullObj,nullObj];
	LmergedArray[0]={d:tmp3,o:tmp4};
	tmp3=tmp0.a1;
	tmp2=tmp0.a1o|0;
	tmp0=__ZSt13__rewrap_iterB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_St18__unwrap_iter_implIS4_Lb1EEET_S7_T0_(Larg3,Marg3,tmp3,tmp2);
	tmp4=oSlot;
	LmergedArray[1]={d:tmp0,o:tmp4};
	__ZSt9make_pairB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_ESt4pairINSt18__unwrap_ref_decayIT_E4typeENS6_IT0_E4typeEEOS7_OSA_(Larg0,LmergedArray,0,LmergedArray,1);
}
function __ZSt11__move_implB7v160000ISt17_ClassicAlgPolicyPN13StreamNetwork11AcceptQueue7PendingES4_vESt4pairIPT0_PT1_ES7_S7_S9_(Larg0,Larg1,Marg1,Larg2,Marg2,Larg3,Marg3){
	var tmp0=0,tmp1=0,LmergedArray=null,Lgeptoindexphi15=0,Lgeptoindexphi=0,Lgeptoindexphi3=0,Lxtraiter=0,Lprol$piter=0;
	tmp1=(__imul(Marg2,4))-(__imul(Marg1,4))|0;
	if(tmp1>>>0>=4){
		Lgeptoindexphi15=tmp1>>>2;
		if(Marg1<Marg3){
			Lgeptoindexphi=tmp1-4|0;
			Lgeptoindexphi3=(Lgeptoindexphi>>>2)+1&3;
			if((Lgeptoindexphi3|0)!==0){
				Lxtraiter=Lgeptoindexphi15;
				Lprol$piter=0;
				while(1){
					Lxtraiter=Lxtraiter-1|0;
					LmergedArray=Larg1[Marg1+Lxtraiter|0];
					Lgeptoindexphi15=Lgeptoindexphi15-1|0;
					Larg3[Marg3+Lgeptoindexphi15|0]=LmergedArray;
					Lprol$piter=Lprol$piter+1|0;
					if((Lprol$piter|0)!==(Lgeptoindexphi3|0))continue;
					break;
				}
			}else{
				Lxtraiter=Lgeptoindexphi15;
			}
			if(Lgeptoindexphi>>>0>=12)while(1){
				LmergedArray=Larg1[(Marg1+Lxtraiter|0)+ -1|0];
				Larg3[(Marg3+Lgeptoindexphi15|0)+ -1|0]=LmergedArray;
				LmergedArray=Larg1[(Marg1+Lxtraiter|0)+ -2|0];
				Larg3[(Marg3+Lgeptoindexphi15|0)+ -2|0]=LmergedArray;
				LmergedArray=Larg1[(Marg1+Lxtraiter|0)+ -3|0];
				Larg3[(Marg3+Lgeptoindexphi15|0)+ -3|0]=LmergedArray;
				Lxtraiter=Lxtraiter-4|0;
				LmergedArray=Larg1[Marg1+Lxtraiter|0];
				Lgeptoindexphi15=Lgeptoindexphi15-4|0;
				Larg3[Marg3+Lgeptoindexphi15|0]=LmergedArray;
				if(Larg3!==Larg3||(Marg3+Lgeptoindexphi15|0)!==Marg3)continue;
				break;
			}
		}else{
			tmp0=tmp1-4|0;
			Lxtraiter=(tmp0>>>2)+1&7;
			if((Lxtraiter|0)!==0){
				Lprol$piter=0;
				Lgeptoindexphi3=0;
				Lgeptoindexphi=0;
				while(1){
					LmergedArray=Larg1[Marg1+Lgeptoindexphi|0];
					Larg3[Marg3+Lgeptoindexphi3|0]=LmergedArray;
					Lprol$piter=Lprol$piter+1|0;
					Lgeptoindexphi3=Lgeptoindexphi3+1|0;
					Lgeptoindexphi=Lgeptoindexphi+1|0;
					if((Lprol$piter|0)!==(Lxtraiter|0))continue;
					break;
				}
			}else{
				Lgeptoindexphi3=0;
				Lgeptoindexphi=0;
			}
			if(tmp0>>>0>=28)while(1){
				LmergedArray=Larg1[Marg1+Lgeptoindexphi|0];
				Larg3[Marg3+Lgeptoindexphi3|0]=LmergedArray;
				LmergedArray=Larg1[(Marg1+Lgeptoindexphi|0)+1|0];
				Larg3[(Marg3+Lgeptoindexphi3|0)+1|0]=LmergedArray;
				LmergedArray=Larg1[(Marg1+Lgeptoindexphi|0)+2|0];
				Larg3[(Marg3+Lgeptoindexphi3|0)+2|0]=LmergedArray;
				LmergedArray=Larg1[(Marg1+Lgeptoindexphi|0)+3|0];
				Larg3[(Marg3+Lgeptoindexphi3|0)+3|0]=LmergedArray;
				LmergedArray=Larg1[(Marg1+Lgeptoindexphi|0)+4|0];
				Larg3[(Marg3+Lgeptoindexphi3|0)+4|0]=LmergedArray;
				LmergedArray=Larg1[(Marg1+Lgeptoindexphi|0)+5|0];
				Larg3[(Marg3+Lgeptoindexphi3|0)+5|0]=LmergedArray;
				LmergedArray=Larg1[(Marg1+Lgeptoindexphi|0)+6|0];
				Larg3[(Marg3+Lgeptoindexphi3|0)+6|0]=LmergedArray;
				LmergedArray=Larg1[(Marg1+Lgeptoindexphi|0)+7|0];
				Larg3[(Marg3+Lgeptoindexphi3|0)+7|0]=LmergedArray;
				Lgeptoindexphi3=Lgeptoindexphi3+8|0;
				if(Larg3!==Larg3||(Marg3+Lgeptoindexphi15|0)!==(Marg3+Lgeptoindexphi3|0)){
					Lgeptoindexphi=Lgeptoindexphi+8|0;
					continue;
				}
				break;
			}
		}
	}
	tmp1>>=2;
	LmergedArray=[nullObj,nullObj];
	LmergedArray[0]={d:Larg1,o:Marg1+tmp1|0};
	LmergedArray[1]={d:Larg3,o:Marg3+tmp1|0};
	__ZSt9make_pairB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_ESt4pairINSt18__unwrap_ref_decayIT_E4typeENS6_IT0_E4typeEEOS7_OSA_(Larg0,LmergedArray,0,LmergedArray,1);
}
function __ZSt9make_pairB7v160000IPPN13StreamNetwork11AcceptQueue7PendingES4_ESt4pairINSt18__unwrap_ref_decayIT_E4typeENS6_IT0_E4typeEEOS7_OSA_(Larg0,Larg1,Marg1,Larg2,Marg2){
	__ZNSt4pairIPPN13StreamNetwork11AcceptQueue7PendingES4_EC2B7v160000IS4_S4_LPv0EEEOT_OT0_(Larg0,Larg1,Marg1,Larg2,Marg2);
}
function __ZNSt4pairIPPN13StreamNetwork11AcceptQueue7PendingES4_EC2B7v160000IS4_S4_LPv0EEEOT_OT0_(Larg0,Larg1,Marg1,Larg2,Marg2){
	var tmp0=null;
	tmp0=Larg1[Marg1];
	Larg0.a0=tmp0.d;
	Larg0.a0o=tmp0.o;
	tmp0=Larg2[Marg2];
	Larg0.a1=tmp0.d;
	Larg0.a1o=tmp0.o;
}
function __ZNKSt17__compressed_pairIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEE5firstB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt22__compressed_pair_elemIPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EE5__getB7v160000Ev(Larg0);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNKSt22__compressed_pair_elemIPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EE5__getB7v160000Ev(Larg0){
	oSlot=0;
	return Larg0.a0;
}
function __ZNSt17__compressed_pairIPN13StreamNetwork11AcceptQueue7PendingESt22__allocator_destructorISaIS2_EEEC2B7v160000IRS3_S6_EEOT_OT0_(Larg0,Larg1,Marg1,Larg2){
	__ZNSt22__compressed_pair_elemIPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EEC2B7v160000IRS3_vEEOT_(Larg0,Larg1,Marg1);
	__ZNSt22__compressed_pair_elemISt22__allocator_destructorISaIN13StreamNetwork11AcceptQueue7PendingEEELi1ELb0EEC2B7v160000IS5_vEEOT_(Larg0.a1,Larg2);
}
function __ZNSt22__compressed_pair_elemIPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EEC2B7v160000IRS3_vEEOT_(Larg0,Larg1,Marg1){
	var tmp0=null;
	tmp0=Larg1[Marg1];
	Larg0.a0[0]=tmp0;
}
function __ZNSt22__compressed_pair_elemISt22__allocator_destructorISaIN13StreamNetwork11AcceptQueue7PendingEEELi1ELb0EEC2B7v160000IS5_vEEOT_(Larg0,Larg1){
	Larg0.a0=Larg1.a0;
	Larg0.i1=Larg1.i1|0;
}
function __ZNSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingERSaIS3_EEC2B7v160000IDnS6_EEOT_OT0_(Larg0,Larg1){
	__ZNSt22__compressed_pair_elemIPPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EEC2B7v160000IDnvEEOT_(Larg0);
	__ZNSt22__compressed_pair_elemIRSaIPN13StreamNetwork11AcceptQueue7PendingEELi1ELb0EEC2B7v160000IS5_vEEOT_(Larg0.a1,Larg1);
}
function __ZSt19__allocate_at_leastB7v160000ISaIPN13StreamNetwork11AcceptQueue7PendingEEESt19__allocation_resultINSt16allocator_traitsIT_E7pointerEERS7_j(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSaIPN13StreamNetwork11AcceptQueue7PendingEE8allocateB7v160000Ej(Larg1);
	tmp1=oSlot;
	Larg0.a0=tmp0;
	Larg0.a0o=tmp1;
	Larg0.i1=Larg1;
}
function __ZNSaIPN13StreamNetwork11AcceptQueue7PendingEE8allocateB7v160000Ej(Larg0){
	var tmp0=null;
	if(Larg0>>>0>1073741823)__ZSt28__throw_bad_array_new_lengthB7v160000v();
	;
	tmp0=createPointerArray([],0,(Larg0<<2)/4|0,nullObj);
	oSlot=0;
	return tmp0;
}
function __ZSt28__throw_bad_array_new_lengthB7v160000v(){
	_abort();
	;
}
function __ZNSt22__compressed_pair_elemIPPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EEC2B7v160000IDnvEEOT_(Larg0){
	Larg0.a0[0]=nullObj;
}
function __ZNSt22__compressed_pair_elemIRSaIPN13StreamNetwork11AcceptQueue7PendingEELi1ELb0EEC2B7v160000IS5_vEEOT_(Larg0,Larg1){
	Larg0.a0=Larg1;
}
function __ZSt3maxB7v160000IjSt6__lessIjjEERKT_S4_S4_T0_(Larg0,Marg0,Larg1,Marg1){
	var tmp0=0;
	tmp0=__ZNKSt6__lessIjjEclB7v160000ERKjS2_(Larg0,Marg0,Larg1,Marg1)|0;
	oSlot=tmp0?Marg1:Marg0;
	return (tmp0?Larg1:Larg0);
}
function __ZNKSt6__lessIjjEclB7v160000ERKjS2_(Larg0,Marg0,Larg1,Marg1){
	return (Larg0[Marg0]>>>0<Larg1[Marg1]>>>0?1:0)|0;
}
function __ZNSaIN13StreamNetwork11AcceptQueue7PendingEE8allocateB7v160000Ej(){
	var tmp0=null;
	tmp0=createArray_struct$p_ZN13StreamNetwork11AcceptQueue7PendingE(512);
	oSlot=0;
	return tmp0;
}
function __ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE10__capacityB7v160000Ev(Larg0){
	var tmp0=0;
	tmp0=__ZNKSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE4sizeB7v160000Ev(Larg0)|0;
	if((tmp0|0)!==0)return (tmp0<<9)-1|0;
	return 0|0;
}
function __ZNSt8optionalIN13StreamNetwork11AcceptQueue7PendingEEaSB7v160000IS2_vEERS3_OT_(Larg0,Larg1){
	var tmp0=null;
	if(__ZNKSt23__optional_storage_baseIN13StreamNetwork11AcceptQueue7PendingELb0EE9has_valueB7v160000Ev(Larg0)|0){
		tmp0=__ZNRSt23__optional_storage_baseIN13StreamNetwork11AcceptQueue7PendingELb0EE5__getB7v160000Ev(Larg0);
		tmp0.a0=Larg1.a0;
		tmp0.a1=Larg1.a1;
	}else __ZNSt23__optional_storage_baseIN13StreamNetwork11AcceptQueue7PendingELb0EE11__constructB7v160000IJS2_EEEvDpOT_(Larg0,Larg1);
	return Larg0;
}
function __ZNSt16coroutine_handleIvEaSB7v160000EDn(Larg0){
	Larg0.a0=nullArray;
	Larg0.a0o=0;
	return Larg0;
}
function __ZNKSt23__optional_storage_baseIN13StreamNetwork11AcceptQueue7PendingELb0EE9has_valueB7v160000Ev(Larg0){
	return ((Larg0.i0&256)!==0?1:0)|0;
}
function __ZNRSt23__optional_storage_baseIN13StreamNetwork11AcceptQueue7PendingELb0EE5__getB7v160000Ev(Larg0){
	return Larg0.a1;
}
function __ZNSt23__optional_storage_baseIN13StreamNetwork11AcceptQueue7PendingELb0EE11__constructB7v160000IJS2_EEEvDpOT_(Larg0,Larg1){
	__ZSt12construct_atB7v160000IN13StreamNetwork11AcceptQueue7PendingEJS2_EPS2_EPT_S5_DpOT0_(Larg0.a1,Larg1);
	Larg0.i0=Larg0.i0&255|256;
}
function __ZNSt16coroutine_handleIvEC2B7v160000EDn(Larg0){
	Larg0.a0=nullArray;
	Larg0.a0o=0;
}
function __ZSteqB7v160000St16coroutine_handleIvES0_(Larg0,Larg1){
	var tmp0=null,tmp1=0,tmp2=null,tmp3=0;
	tmp0=__ZNKSt16coroutine_handleIvE7addressB7v160000Ev(Larg0);
	tmp1=oSlot;
	tmp2=__ZNKSt16coroutine_handleIvE7addressB7v160000Ev(Larg1);
	tmp3=oSlot;
	return (tmp0===tmp2&&tmp1===tmp3?1:0)|0;
}
function __ZNKSt16coroutine_handleIvE7addressB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	oSlot=tmp1;
	return tmp0;
}
function __ZNKSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEptB7v160000Ev(Larg0){
	return __ZNKSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElE8__get_npB7v160000Ev(Larg0).a4;
}
function __ZNKSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElE8__get_npB7v160000Ev(Larg0){
	return Larg0.a0;
}
function __ZN6cheerp12make_closureIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS2_22TCPServerSocketOptionsEEUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISD_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISD_Efp_EEEOSD_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS2_22TCPServerSocketOptionsEEUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_MSC_KFPNS2_7PromiseIPNS2_4_AnyEEESB_EE12make_closureEOSC_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS2_22TCPServerSocketOptionsEEUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_MSC_KFPNS2_7PromiseIPNS2_4_AnyEEESB_EE12make_closureEOSC_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEEEC2IZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlSB_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISL_PSC_EE5valueEvE4typeEPNSO_IXntsrNSD_13_must_destroyISL_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEEEC2IZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlSB_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISL_PSC_EE5valueEvE4typeEPNSO_IXntsrNSD_13_must_destroyISL_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null,a1:{a0:null}}];
	tmp0[0].a0=Larg1.a0;
	tmp0[0].a1.a0=Larg1.a1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_JSI_EEES6_PT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_JSI_EEES6_PT_DpT0_(Larg0,Larg1){
	return __ZZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsEENKUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_clES9_(Larg0,Larg1);
}
function __ZZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsEENKUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_clES9_(Larg0,Larg1){
	var tmp0=null,L$poptgepsqueezed10=null,tmp2=null,tmp3=null;
	tmp2=new constructor__ZZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsEENKUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_clES9_$pFrame().a;
	tmp3=tmp2[0];
	tmp3.a0=__ZZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsEENKUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_clES9_$presume;
	tmp3.a1=__ZZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsEENKUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_clES9_$pdestroy;
	tmp3.a4=Larg1;
	tmp3.a3=Larg0;
	tmp0=__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS0_6StringEPNS0_22TCPServerSocketOptionsEEUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_SF_EE12promise_type17get_return_objectEv(tmp3.a2);
	L$poptgepsqueezed10=tmp3.a5;
	__ZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed10,__ZN13StreamNetwork11AcceptQueue3popEv(__ZNKSt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEEptB7v160000Ev(tmp3.a3.a1).a2));
	tmp3.i6=1;
	tmp3={a0:nullArray,a0o:0};
	__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_SG_EE12promise_typeEE12from_addressB7v160000EPv(tmp3,tmp2,0);
	tmp2={a0:nullArray,a0o:0};
	__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_SG_EE12promise_typeEEcvS_IvEB7v160000Ev(tmp2,tmp3);
	__ZZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed10,tmp2);
	return tmp0;
}
function __ZZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsEENKUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_clES9_$presume(Larg0,Marg0){
	var L$poptgepsqueezed8=null,tmp1=null,tmp2=null;
	L$poptgepsqueezed8=Larg0[Marg0].a5;
	if((Larg0[Marg0].i6&3)!==0){
		tmp2=__ZZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EEENK15promise_awaiter12await_resumeEv(L$poptgepsqueezed8);
		__ZZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed8);
		if(tmp2!==null)Larg0[Marg0].a4.enqueue(tmp2);
		__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS0_6StringEPNS0_22TCPServerSocketOptionsEEUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_SF_EE12promise_type12return_valueES3_(Larg0[Marg0].a2);
	}else{
		__ZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed8,__ZN13StreamNetwork11AcceptQueue3popEv(__ZNKSt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEEptB7v160000Ev(Larg0[Marg0].a3.a1).a2));
		Larg0[Marg0].i6=1;
		tmp2={a0:nullArray,a0o:0};
		__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_SG_EE12promise_typeEE12from_addressB7v160000EPv(tmp2,Larg0,Marg0);
		tmp1={a0:nullArray,a0o:0};
		__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_SG_EE12promise_typeEEcvS_IvEB7v160000Ev(tmp1,tmp2);
		__ZZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed8,tmp1);
	}
}
function __ZZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsEENKUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_clES9_$pdestroy(Larg0,Marg0){
	Larg0=Larg0[Marg0];
	var tmp0=0;
	tmp0=Larg0.i6|0;
	if(Larg0.a0!==null)if((tmp0&3)!==0)__ZZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0.a5);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS0_6StringEPNS0_22TCPServerSocketOptionsEEUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_SF_EE12promise_type17get_return_objectEv(Larg0){
	var tmp0=null;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	return new Promise(_cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRKZN13StreamNetwork15TCPServerSocketEPNS_6StringEPNS_22TCPServerSocketOptionsEEUlPNS_31ReadableStreamDefaultControllerIPNS_6ObjectEEEE_SV_EE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(tmp0));
}
function __ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_SG_EE12promise_typeEE12from_addressB7v160000EPv(Larg0,Larg1,Marg1){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_SG_EE12promise_typeEEcvS_IvEB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_SG_EE12promise_typeEE7addressB7v160000Ev(Larg1);
	tmp1=oSlot;
	__ZNSt16coroutine_handleIvE12from_addressB7v160000EPv(Larg0,tmp0,tmp1);
}
function __ZN13StreamNetwork11AcceptQueue3popEv(Larg0){
	var tmp0=null,tmp1=null,tmp2=null,tmp3=null,L$poptgepsqueezed14=null,L$poptgep$poptgep6$poptgepsqueezed=null;
	tmp2=new constructor__ZN13StreamNetwork11AcceptQueue3popEv$pFrame().a;
	tmp3=tmp2[0];
	tmp3.a0=__ZN13StreamNetwork11AcceptQueue3popEv$presume;
	tmp3.a1=__ZN13StreamNetwork11AcceptQueue3popEv$pdestroy;
	tmp3.a3=Larg0;
	L$poptgepsqueezed14=tmp3.a2;
	tmp0=__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEv(L$poptgepsqueezed14);
	L$poptgep$poptgep6$poptgepsqueezed=tmp3.a3;
	tmp1=L$poptgep$poptgep6$poptgepsqueezed.a3;
	if(__ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE5emptyB7v160000Ev(tmp1)|0){
		L$poptgepsqueezed14=tmp3.a6;
		__ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEEawEv(L$poptgepsqueezed14,L$poptgep$poptgep6$poptgepsqueezed);
		tmp3.i7=1;
		tmp3={a0:nullArray,a0o:0};
		__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_typeEE12from_addressB7v160000EPv(tmp3,tmp2,0);
		tmp2={a0:nullArray,a0o:0};
		__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_typeEEcvS_IvEB7v160000Ev(tmp2,tmp3);
		__ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE7Awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed14,tmp2);
	}else{
		tmp2=__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE5frontEv(tmp1);
		L$poptgep$poptgep6$poptgepsqueezed=tmp3.a4;
		L$poptgep$poptgep6$poptgepsqueezed.a0=tmp2.a0;
		L$poptgep$poptgep6$poptgepsqueezed.a1=tmp2.a1;
		__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE9pop_frontEv(tmp1);
		tmp2=L$poptgep$poptgep6$poptgepsqueezed.a1;
		if(tmp2!==null)tmp2.call(null);
		__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type12return_valueES3_(L$poptgepsqueezed14,L$poptgep$poptgep6$poptgepsqueezed.a0);
	}
	return tmp0;
}
function __ZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EE(Larg0,Larg1){
	__ZZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EEEN15promise_awaiterC2EPNS3_IS2_EE(Larg0,Larg1);
}
function __ZZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(Larg0,Larg1){
	var tmp0=null,tmp1=null,tmp2=null,tmp3=null,tmp4=0;
	tmp0=new Uint8Array(1);
	tmp0[0]=0;
	Larg0.a2=tmp0;
	tmp1=Larg0.a0;
	tmp2={a0:null,a1:{a0:nullArray,a0o:0},a2:nullArray};
	tmp2.a0=Larg0;
	tmp3=Larg1.a0;
	tmp4=Larg1.a0o|0;
	tmp2.a1.a0=tmp3;
	tmp2.a1.a0o=tmp4;
	tmp2.a2=tmp0;
	tmp1.then(_cheerpCreate_ZN6client9_FunctionIFPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEPNS_6ObjectEEEC2IZZawISA_EDaRNS_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlSA_E_vEEOSG_(tmp2));
}
function __ZZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EEENK15promise_awaiter12await_resumeEv(Larg0){
	return Larg0.a1;
}
function __ZZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a2;
	if(tmp0!==nullArray||0!==0)tmp0[0]=1;
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS0_6StringEPNS0_22TCPServerSocketOptionsEEUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_SF_EE12promise_type12return_valueES3_(Larg0){
	Larg0.a0.call(null,null);
}
function _cheerpCreate_ZN6client9_FunctionIFPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEPNS_6ObjectEEEC2IZZawISA_EDaRNS_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlSA_E_vEEOSG_(Larg0){
	return __ZN6cheerp8CallbackIRZZawIPN6client6ObjectEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_EEPNS2_13EventListenerEOS6_(Larg0);
}
function __ZN6cheerp8CallbackIRZZawIPN6client6ObjectEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_EEPNS2_13EventListenerEOS6_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZZawIPN6client6ObjectEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_EEDTclsr13ClosureHelperIS6_DTadsr6cheerp7utility16remove_referenceIS6_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS6_Efp_EEEOS6_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client6ObjectEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client6ObjectEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZZawIPN6client6ObjectEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_EEDTclsr13ClosureHelperIS6_DTadsr6cheerp7utility16remove_referenceIS6_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS6_Efp_EEEOS6_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZZawIPN6client6ObjectEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_MSC_KFvS4_EE12make_closureESD_(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client6ObjectEEEcvPNS1_13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFvPN6client6ObjectEEE14deleter_helperEPNS5_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFvPN6client6ObjectEEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFvPN6client6ObjectEEE14deleter_helperEPNS5_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp13ClosureHelperIRZZawIPN6client6ObjectEEDaRNS2_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS4_E_MSC_KFvS4_EE12make_closureESD_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client6ObjectEEEC2IRZZawIS3_EDaRNS1_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS3_E_EEOS9_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS9_PS4_EE5valueEvE4typeEPNSJ_IXntsrNS5_13_must_destroyIS9_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client6ObjectEEEC2IRZZawIS3_EDaRNS1_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS3_E_EEOS9_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleIS9_PS4_EE5valueEvE4typeEPNSJ_IXntsrNS5_13_must_destroyIS9_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=0,tmp2=null;
	tmp0=[{a0:null,a1:{a0:nullArray,a0o:0},a2:nullArray}];
	tmp0[0].a0=Larg1.a0;
	tmp2=Larg1.a1.a0;
	tmp1=Larg1.a1.a0o|0;
	tmp0[0].a1.a0=tmp2;
	tmp0[0].a1.a0o=tmp1;
	tmp2=Larg1.a2;
	tmp0[0].a2=tmp2;
	tmp2=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZZawIPN6client6ObjectEEDaRNS4_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS6_E_JS6_EEEvPS8_DpT0_,tmp0[0]);
	Larg0.a0=tmp2;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZZawIPN6client6ObjectEEDaRNS4_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEEUlS6_E_JS6_EEEvPS8_DpT0_(Larg0,Larg1){
	__ZZZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEENKUlS2_E_clES2_(Larg0,Larg1);
}
function __ZZZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvEENKUlS2_E_clES2_(Larg0,Larg1){
	var tmp0=null;
	tmp0=Larg0.a2;
	if((tmp0[0]&1)===0){
		tmp0=Larg0.a0;
		tmp0.a1=Larg1;
		tmp0.a2=nullArray;
		__ZNKSt16coroutine_handleIvE6resumeB7v160000Ev(Larg0.a1);
	}
}
function __ZZawIPN6client6ObjectEEDaRNS0_7PromiseIT_EEEN15promise_awaiterC2EPNS3_IS2_EE(Larg0,Larg1){
	Larg0.a2=nullArray;
	Larg0.a0=Larg1;
}
function __ZN13StreamNetwork11AcceptQueue3popEv$presume(Larg0,Marg0){
	var L$poptgepsqueezed18=null,L$poptgepsqueezed19=null,L$poptgepsqueezed14=null,tmp3=null;
	L$poptgepsqueezed18=Larg0[Marg0].a6;
	L$poptgepsqueezed19=Larg0[Marg0].a4;
	a:{
		if((Larg0[Marg0].i7&3)!==0){
			L$poptgepsqueezed14=Larg0[Marg0].a5;
			__ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE7Awaiter12await_resumeEv(L$poptgepsqueezed14,L$poptgepsqueezed18);
			tmp3=L$poptgepsqueezed14.a0;
			L$poptgepsqueezed19.a0=tmp3;
			L$poptgepsqueezed14=L$poptgepsqueezed14.a1;
			L$poptgepsqueezed19.a1=L$poptgepsqueezed14;
			__ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE7AwaiterD2Ev(L$poptgepsqueezed18);
			L$poptgepsqueezed18=L$poptgepsqueezed14;
		}else{
			tmp3=Larg0[Marg0].a3;
			L$poptgepsqueezed14=tmp3.a3;
			if(__ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE5emptyB7v160000Ev(L$poptgepsqueezed14)|0){
				__ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEEawEv(L$poptgepsqueezed18,tmp3);
				Larg0[Marg0].i7=1;
				L$poptgepsqueezed19={a0:nullArray,a0o:0};
				__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_typeEE12from_addressB7v160000EPv(L$poptgepsqueezed19,Larg0,Marg0);
				L$poptgepsqueezed14={a0:nullArray,a0o:0};
				__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_typeEEcvS_IvEB7v160000Ev(L$poptgepsqueezed14,L$poptgepsqueezed19);
				__ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE7Awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed18,L$poptgepsqueezed14);
				break a;
			}
			L$poptgepsqueezed18=__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE5frontEv(L$poptgepsqueezed14);
			tmp3=L$poptgepsqueezed18.a0;
			L$poptgepsqueezed19.a0=tmp3;
			L$poptgepsqueezed18=L$poptgepsqueezed18.a1;
			L$poptgepsqueezed19.a1=L$poptgepsqueezed18;
			__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE9pop_frontEv(L$poptgepsqueezed14);
		}
		if(L$poptgepsqueezed18!==null)L$poptgepsqueezed18.call(null);
		__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type12return_valueES3_(Larg0[Marg0].a2,tmp3);
	}
}
function __ZN13StreamNetwork11AcceptQueue3popEv$pdestroy(Larg0,Marg0){
	Larg0=Larg0[Marg0];
	var tmp0=0;
	tmp0=Larg0.i7|0;
	if(Larg0.a0!==null)if((tmp0&3)!==0)__ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE7AwaiterD2Ev(Larg0.a6);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEv(Larg0){
	var tmp0=null;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	return new Promise(_cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIPNS_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(tmp0));
}
function __ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_typeEE12from_addressB7v160000EPv(Larg0,Larg1,Marg1){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_typeEEcvS_IvEB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_typeEE7addressB7v160000Ev(Larg1);
	tmp1=oSlot;
	__ZNSt16coroutine_handleIvE12from_addressB7v160000EPv(Larg0,tmp0,tmp1);
}
function __ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE5emptyB7v160000Ev(Larg0){
	return (((__ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE4sizeB7v160000Ev(Larg0)|0)|0)===0?1:0)|0;
}
function __ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEEawEv(Larg0,Larg1){
	__ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE7AwaiterC2EPS3_(Larg0,Larg1);
}
function __ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE7Awaiter13await_suspendESt16coroutine_handleIvE(Larg0,Larg1){
	var tmp0=null,tmp1=null,tmp2=0;
	tmp0=Larg0.a0;
	tmp1=Larg1.a0;
	tmp2=Larg1.a0o|0;
	tmp0.a0=tmp1;
	tmp0.a0o=tmp2;
}
function __ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE7Awaiter12await_resumeEv(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=Larg1.a0.a1;
	tmp1=__ZNRSt8optionalIN13StreamNetwork11AcceptQueue7PendingEEdeB7v160000Ev(tmp0);
	Larg0.a0=tmp1.a0;
	Larg0.a1=tmp1.a1;
	__ZNSt24__optional_destruct_baseIN13StreamNetwork11AcceptQueue7PendingELb1EE5resetB7v160000Ev(tmp0);
}
function __ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE7AwaiterD2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a0;
	if(tmp0!==null)__ZNSt16coroutine_handleIvEaSB7v160000EDn(tmp0);
}
function __ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE5frontEv(Larg0){
	var tmp0=0,tmp1=0,tmp2=null;
	tmp2=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5beginB7v160000Ev(Larg0);
	tmp0=oSlot;
	tmp1=Larg0.i4|0;
	tmp2=tmp2[tmp0+(tmp1>>>9)|0];
	return tmp2.d[tmp2.o+(tmp1&511)|0];
}
function __ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE9pop_frontEv(Larg0){
	var tmp0=0,tmp1=null,tmp2=0;
	tmp1=__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE5beginB7v160000Ev(Larg0);
	tmp2=oSlot;
	tmp0=Larg0.i4|0;
	tmp1=tmp1[tmp2+(tmp0>>>9)|0];
	__ZNSt16allocator_traitsISaIN13StreamNetwork11AcceptQueue7PendingEEE7destroyB7v160000IS2_vvEEvRS3_PT_(tmp1.d[tmp1.o+(tmp0&511)|0]);
	tmp1=__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE6__sizeB7v160000Ev(Larg0);
	tmp2=oSlot;
	tmp1[tmp2]=(tmp1[tmp2]|0)-1|0;
	Larg0.i4=(Larg0.i4|0)+1|0;
	__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE26__maybe_remove_front_spareB7v160000Eb(Larg0);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type12return_valueES3_(Larg0,Larg1){
	Larg0.a0.call(null,Larg1);
}
function __ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE26__maybe_remove_front_spareB7v160000Eb(Larg0){
	if((__ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE20__front_spare_blocksB7v160000Ev(Larg0)|0)>>>0>1){
		__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EE9pop_frontB7v160000Ev(Larg0);
		Larg0.i4=(Larg0.i4|0)-512|0;
	}
}
function __ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE20__front_spare_blocksB7v160000Ev(Larg0){
	return (__ZNKSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EE13__front_spareB7v160000Ev(Larg0)|0)>>>9|0;
}
function __ZNRSt8optionalIN13StreamNetwork11AcceptQueue7PendingEEdeB7v160000Ev(Larg0){
	return __ZNRSt23__optional_storage_baseIN13StreamNetwork11AcceptQueue7PendingELb0EE5__getB7v160000Ev(Larg0);
}
function __ZNSt24__optional_destruct_baseIN13StreamNetwork11AcceptQueue7PendingELb1EE5resetB7v160000Ev(Larg0){
	var tmp0=0;
	tmp0=Larg0.i0|0;
	if((tmp0&256)!==0)Larg0.i0=tmp0&255;
}
function __ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE7AwaiterC2EPS3_(Larg0,Larg1){
	Larg0.a0=Larg1;
	if(Larg1.a2!==null)___assert_fail(_$pstr$p3$p4,0,_$pstr$p4$p5,0,25,___func__$p_ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE7AwaiterC2EPS3_,0);
	;
	Larg1.a2=Larg0;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_typeEE7addressB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	oSlot=tmp1;
	return tmp0;
}
function _cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIPNS_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(Larg0){
	return __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0);
}
function __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISH_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISH_Efp_EEEOSH_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client8FunctionEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISH_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISH_Efp_EEEOSH_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSF_KFvSE_EE12make_closureESG_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSF_KFvSE_EE12make_closureESG_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISK_PS4_EE5valueEvE4typeEPNSN_IXntsrNS5_13_must_destroyISK_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISK_PS4_EE5valueEvE4typeEPNSN_IXntsrNS5_13_must_destroyISK_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSG_EEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSG_EEEvPT_DpT0_(Larg0,Larg1){
	__ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESC_(Larg0,Larg1);
}
function __ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_6ObjectEEEJRN13StreamNetwork11AcceptQueueEEE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESC_(Larg0,Larg1){
	Larg0.a0.a0=Larg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_SG_EE12promise_typeEE7addressB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	oSlot=tmp1;
	return tmp0;
}
function _cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRKZN13StreamNetwork15TCPServerSocketEPNS_6StringEPNS_22TCPServerSocketOptionsEEUlPNS_31ReadableStreamDefaultControllerIPNS_6ObjectEEEE_SV_EE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(Larg0){
	return __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS2_6StringEPNS2_22TCPServerSocketOptionsEEUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_SH_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0);
}
function __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS2_6StringEPNS2_22TCPServerSocketOptionsEEUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_SH_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS2_6StringEPNS2_22TCPServerSocketOptionsEEUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_SH_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISR_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISR_Efp_EEEOSR_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client8FunctionEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS2_6StringEPNS2_22TCPServerSocketOptionsEEUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_SH_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISR_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISR_Efp_EEEOSR_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS2_6StringEPNS2_22TCPServerSocketOptionsEEUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_SH_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSP_KFvSO_EE12make_closureESQ_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS2_6StringEPNS2_22TCPServerSocketOptionsEEUlPNS2_31ReadableStreamDefaultControllerIPNS2_6ObjectEEEE_SH_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSP_KFvSO_EE12make_closureESQ_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_SM_EE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISU_PS4_EE5valueEvE4typeEPNSX_IXntsrNS5_13_must_destroyISU_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS1_6StringEPNS1_22TCPServerSocketOptionsEEUlPNS1_31ReadableStreamDefaultControllerIPNS1_6ObjectEEEE_SM_EE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISU_PS4_EE5valueEvE4typeEPNSX_IXntsrNS5_13_must_destroyISU_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS4_6StringEPNS4_22TCPServerSocketOptionsEEUlPNS4_31ReadableStreamDefaultControllerIPNS4_6ObjectEEEE_SJ_EE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSQ_EEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS4_6StringEPNS4_22TCPServerSocketOptionsEEUlPNS4_31ReadableStreamDefaultControllerIPNS4_6ObjectEEEE_SJ_EE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JSQ_EEEvPT_DpT0_(Larg0,Larg1){
	__ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS0_6StringEPNS0_22TCPServerSocketOptionsEEUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_SF_EE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESM_(Larg0,Larg1);
}
function __ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork15TCPServerSocketEPNS0_6StringEPNS0_22TCPServerSocketOptionsEEUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_SF_EE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESM_(Larg0,Larg1){
	Larg0.a0.a0=Larg1;
}
function __ZNSt10__get_pairILj1EE3getB7v160000ISt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS5_11AcceptQueueEEPSt11__tree_nodeIS8_PvElEEbEEOT0_OSt4pairIT_SF_E(Larg0){
	oSlot=0;
	return Larg0.a1;
}
function __ZNSt10__get_pairILj0EE3getB7v160000ISt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS5_11AcceptQueueEEPSt11__tree_nodeIS8_PvElEEbEEOT_OSt4pairISF_T0_E(Larg0){
	return Larg0;
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE16__emplace_uniqueB7v160000IJRKSt21piecewise_construct_tSt5tupleIJRS2_EESF_IJEEEEESt4pairISt15__tree_iteratorIS4_PSt11__tree_nodeIS4_PvElEbEDpOT_(Larg0,Larg1,Larg2){
	__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE21__emplace_unique_implIJRKSt21piecewise_construct_tSt5tupleIJRS2_EESF_IJEEEEESt4pairISt15__tree_iteratorIS4_PSt11__tree_nodeIS4_PvElEbEDpOT_(Larg0,Larg1,Larg2);
}
function __ZNSt4pairISt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS3_11AcceptQueueEEPSt11__tree_nodeIS6_PvElEEbEC2B7v160000ISB_bLS8_0EEEOS_IT_T0_E(Larg0,Larg1){
	var L$psroa$p0$p0$pcopyload=null,tmp1=null;
	L$psroa$p0$p0$pcopyload=Larg1.a0;
	tmp1={a0:null};
	tmp1.a0=L$psroa$p0$p0$pcopyload;
	__ZNSt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEEC2B7v160000ESA_(Larg0,tmp1);
	Larg0.a1[0]=Larg1.i1&1;
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE21__emplace_unique_implIJRKSt21piecewise_construct_tSt5tupleIJRS2_EESF_IJEEEEESt4pairISt15__tree_iteratorIS4_PSt11__tree_nodeIS4_PvElEbEDpOT_(Larg0,Larg1,Larg2){
	var tmp0=null,tmp1=null,tmp2=null,tmp3=0,tmp4=null,tmp5=null,tmp6=null;
	tmp0={a0:[null],a1:{a0:null,i1:0}};
	__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE16__construct_nodeIJRKSt21piecewise_construct_tSt5tupleIJRS2_EESF_IJEEEEESt10unique_ptrISt11__tree_nodeIS4_PvESt22__tree_node_destructorISaISM_EEEDpOT_(tmp0,Larg1,Larg2);
	tmp6=__ZNKSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEEptB7v160000Ev(tmp0);
	tmp1=[null];
	tmp2=__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE12__find_equalIS4_EERPSt16__tree_node_baseIPvERPSt15__tree_end_nodeISF_ERKT_(Larg1,tmp1,0,tmp6.a4);
	tmp3=oSlot;
	tmp6=tmp2[tmp3];
	tmp4=[0];
	tmp4[0]=0;
	tmp5={a0:null};
	if(tmp6!==null){
		__ZNSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEC2B7v160000ES8_(tmp5,tmp6);
		__ZNSt4pairISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEbEC2B7v160000ISA_RbLS7_0EEEOT_OT0_(Larg0,tmp5,tmp4,0);
		__ZNSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEED2B7v160000Ev(tmp0);
		return;
	}
	__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE16__insert_node_atEPSt15__tree_end_nodeIPSt16__tree_node_baseIPvEERSF_SF_(Larg1,tmp1[0],tmp2,tmp3,__ZNKSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE3getB7v160000Ev(tmp0));
	tmp6=__ZNSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE7releaseB7v160000Ev(tmp0);
	tmp4[0]=1;
	__ZNSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEC2B7v160000ES8_(tmp5,tmp6);
	__ZNSt4pairISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEbEC2B7v160000ISA_RbLS7_0EEEOT_OT0_(Larg0,tmp5,tmp4,0);
	__ZNSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEED2B7v160000Ev(tmp0);
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE16__construct_nodeIJRKSt21piecewise_construct_tSt5tupleIJRS2_EESF_IJEEEEESt10unique_ptrISt11__tree_nodeIS4_PvESt22__tree_node_destructorISaISM_EEEDpOT_(Larg0,Larg1,Larg2){
	var tmp0=null,tmp1=null,tmp2=null;
	tmp0=__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE12__node_allocB7v160000Ev(Larg1);
	tmp1=__ZNSt16allocator_traitsISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEEE8allocateB7v160000ERS8_j();
	tmp2={a0:null,i1:0};
	__ZNSt22__tree_node_destructorISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEEEC2B7v160000ERS8_b(tmp2,tmp0);
	__ZNSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEEC2B7v160000ILb1EvEEPS7_NSt16__dependent_typeISt27__unique_ptr_deleter_sfinaeISA_EXT_EE20__good_rval_ref_typeE(Larg0,tmp1,tmp2);
	__ZNSt16allocator_traitsISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEEE9constructB7v160000ISt4pairIKS3_S4_EJRKSt21piecewise_construct_tSt5tupleIJRS3_EESH_IJEEEvvEEvRS8_PT_DpOT0_(__ZNSt22__tree_key_value_typesISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEE9__get_ptrB7v160000ERS4_(__ZNKSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEEptB7v160000Ev(Larg0).a4),Larg2);
	__ZNSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE11get_deleterB7v160000Ev(Larg0).i1=1;
}
function __ZNKSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEEptB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt17__compressed_pairIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE5firstB7v160000Ev(Larg0);
	tmp1=oSlot;
	return tmp0[tmp1];
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE12__find_equalIS4_EERPSt16__tree_node_baseIPvERPSt15__tree_end_nodeISF_ERKT_(Larg0,Larg1,Marg1,Larg2){
	var tmp0=null,tmp1=null,tmp2=null,tmp3=0,L$pin=null;
	tmp1=__ZNKSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE6__rootB7v160000Ev(Larg0);
	if(tmp1===null){
		tmp1=__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10__end_nodeB7v160000Ev(Larg0);
		Larg1[Marg1]=tmp1;
		oSlot=0;
		return tmp1.a0;
	}
	tmp2=__ZNKSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10__root_ptrEv(Larg0);
	tmp3=oSlot;
	tmp0=__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10value_compB7v160000Ev(Larg0);
	while(1){
		L$pin=tmp1.a4;
		if(__ZNKSt19__map_value_compareIN13StreamNetwork11ServiceAddrESt12__value_typeIS1_NS0_11AcceptQueueEESt4lessIS1_ELb1EEclB7v160000ERKS4_S9_(tmp0,Larg2,L$pin)|0){
			L$pin=tmp1.a0[0];
			if(L$pin===null){
				Larg1[Marg1]=tmp1;
				oSlot=0;
				return tmp1.a0;
			}
			tmp2=tmp1.a0;
			tmp3=0;
		}else{
			if(!(__ZNKSt19__map_value_compareIN13StreamNetwork11ServiceAddrESt12__value_typeIS1_NS0_11AcceptQueueEESt4lessIS1_ELb1EEclB7v160000ERKS4_S9_(tmp0,L$pin,Larg2)|0)){
				Larg1[Marg1]=tmp1;
				oSlot=tmp3;
				return tmp2;
			}
			L$pin=tmp1.a1[0];
			if(L$pin===null){
				Larg1[Marg1]=tmp1;
				oSlot=0;
				return tmp1.a1;
			}
			tmp2=tmp1.a1;
			tmp3=0;
		}
		tmp1=L$pin;
		continue;
	}
}
function __ZNKSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE3getB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt17__compressed_pairIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE5firstB7v160000Ev(Larg0);
	tmp1=oSlot;
	return tmp0[tmp1];
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE16__insert_node_atEPSt15__tree_end_nodeIPSt16__tree_node_baseIPvEERSF_SF_(Larg0,Larg1,Larg2,Marg2,Larg3){
	var tmp0=null,tmp1=null,tmp2=0;
	Larg3.a0[0]=null;
	Larg3.a1[0]=null;
	Larg3.a2=Larg1;
	Larg2[Marg2]=Larg3;
	tmp1=__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE12__begin_nodeB7v160000Ev(Larg0);
	tmp2=oSlot;
	tmp0=tmp1[tmp2].a0[0];
	if(tmp0!==null){
		tmp1[tmp2]=tmp0;
		tmp1=Larg2[Marg2];
	}else{
		tmp1=Larg3;
	}
	__ZSt27__tree_balance_after_insertB7v160000IPSt16__tree_node_baseIPvEEvT_S4_(__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10__end_nodeB7v160000Ev(Larg0).a0[0],tmp1);
	tmp1=__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE4sizeB7v160000Ev(Larg0);
	tmp2=oSlot;
	tmp1[tmp2]=(tmp1[tmp2]|0)+1|0;
}
function __ZNSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE7releaseB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0,tmp2=null;
	tmp0=__ZNSt17__compressed_pairIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE5firstB7v160000Ev(Larg0);
	tmp1=oSlot;
	tmp2=tmp0[tmp1];
	tmp0[tmp1]=null;
	return tmp2;
}
function __ZNSt4pairISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEbEC2B7v160000ISA_RbLS7_0EEEOT_OT0_(Larg0,Larg1,Larg2,Marg2){
	Larg0.a0=Larg1.a0;
	Larg0.i1=Larg2[Marg2]&1;
}
function __ZNSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEED2B7v160000Ev(Larg0){
	__ZNSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE5resetB7v160000EPS7_(Larg0);
}
function __ZNSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE5resetB7v160000EPS7_(Larg0){
	var tmp0=null,tmp1=0,tmp2=null;
	tmp0=__ZNSt17__compressed_pairIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE5firstB7v160000Ev(Larg0);
	tmp1=oSlot;
	tmp2=tmp0[tmp1];
	tmp0[tmp1]=null;
	if(tmp2!==null)__ZNSt22__tree_node_destructorISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEEEclB7v160000EPS7_(__ZNSt17__compressed_pairIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE6secondB7v160000Ev(Larg0),tmp2);
}
function __ZNSt17__compressed_pairIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE5firstB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSt22__compressed_pair_elemIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvELi0ELb0EE5__getB7v160000Ev(Larg0);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNSt17__compressed_pairIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE6secondB7v160000Ev(Larg0){
	return __ZNSt22__compressed_pair_elemISt22__tree_node_destructorISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS3_11AcceptQueueEEPvEEELi1ELb0EE5__getB7v160000Ev(Larg0.a1);
}
function __ZNSt22__tree_node_destructorISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEEEclB7v160000EPS7_(Larg0,Larg1){
	if((Larg0.i1&1)!==0)__ZNSt16allocator_traitsISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEEE7destroyB7v160000ISt4pairIKS3_S4_EvvEEvRS8_PT_(__ZNSt22__tree_key_value_typesISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEE9__get_ptrB7v160000ERS4_(Larg1.a4));
}
function __ZNSt22__compressed_pair_elemISt22__tree_node_destructorISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS3_11AcceptQueueEEPvEEELi1ELb0EE5__getB7v160000Ev(Larg0){
	return Larg0;
}
function __ZNSt22__compressed_pair_elemIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvELi0ELb0EE5__getB7v160000Ev(Larg0){
	oSlot=0;
	return Larg0.a0;
}
function __ZSt27__tree_balance_after_insertB7v160000IPSt16__tree_node_baseIPvEEvT_S4_(Larg0,Larg1){
	var tmp0=0,tmp1=null,tmp2=null,tmp3=null;
	tmp0=Larg1===Larg0?1:0;
	Larg1.i3=tmp0?1:0;
	a:if(!(tmp0)){
		tmp2=Larg1;
		while(1){
			tmp1=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(tmp2);
			if((tmp1.i3&1)===0){
				b:{
					if(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(tmp1)|0){
						tmp3=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(tmp1).a1[0];
						if(tmp3!==null)if((tmp3.i3&1)===0){
							tmp1.i3=1;
							tmp2=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(tmp1);
							tmp2.i3=tmp2===Larg0?1:0;
							tmp3.i3=1;
							break b;
						}
						if(!(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(tmp2)|0)){
							__ZSt18__tree_left_rotateB7v160000IPSt16__tree_node_baseIPvEEvT_(tmp1);
							tmp2=tmp1;
						}
						tmp2=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(tmp2);
						tmp2.i3=1;
						tmp2=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(tmp2);
						tmp2.i3=0;
						__ZSt19__tree_right_rotateB7v160000IPSt16__tree_node_baseIPvEEvT_(tmp2);
						break a;
					}
					tmp3=tmp1.a2.a0[0];
					if(tmp3!==null)if((tmp3.i3&1)===0){
						tmp1.i3=1;
						tmp2=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(tmp1);
						tmp2.i3=tmp2===Larg0?1:0;
						tmp3.i3=1;
						break b;
					}
					if(__ZSt20__tree_is_left_childB7v160000IPSt16__tree_node_baseIPvEEbT_(tmp2)|0){
						__ZSt19__tree_right_rotateB7v160000IPSt16__tree_node_baseIPvEEvT_(tmp1);
						tmp2=tmp1;
					}
					tmp2=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(tmp2);
					tmp2.i3=1;
					tmp2=__ZNKSt16__tree_node_baseIPvE15__parent_unsafeB7v160000Ev(tmp2);
					tmp2.i3=0;
					__ZSt18__tree_left_rotateB7v160000IPSt16__tree_node_baseIPvEEvT_(tmp2);
					break a;
				}
				if(tmp2!==Larg0)continue;
			}
			break;
		}
	}
}
function __ZNKSt17__compressed_pairIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE5firstB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt22__compressed_pair_elemIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvELi0ELb0EE5__getB7v160000Ev(Larg0);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZNKSt22__compressed_pair_elemIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvELi0ELb0EE5__getB7v160000Ev(Larg0){
	oSlot=0;
	return Larg0.a0;
}
function __ZNKSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10__root_ptrEv(Larg0){
	var tmp0=null;
	tmp0=__ZNKSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10__end_nodeB7v160000Ev(Larg0);
	oSlot=0;
	return tmp0.a0;
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10value_compB7v160000Ev(Larg0){
	return __ZNSt17__compressed_pairIjSt19__map_value_compareIN13StreamNetwork11ServiceAddrESt12__value_typeIS2_NS1_11AcceptQueueEESt4lessIS2_ELb1EEE6secondB7v160000Ev(Larg0.a2[0]);
}
function __ZNKSt19__map_value_compareIN13StreamNetwork11ServiceAddrESt12__value_typeIS1_NS0_11AcceptQueueEESt4lessIS1_ELb1EEclB7v160000ERKS4_S9_(Larg0,Larg1,Larg2){
	return (__ZNKSt4lessIN13StreamNetwork11ServiceAddrEEclB7v160000ERKS1_S4_(__ZNKSt12__value_typeIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEE11__get_valueB7v160000Ev(Larg1),__ZNKSt12__value_typeIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEE11__get_valueB7v160000Ev(Larg2))|0)|0;
}
function __ZNKSt12__value_typeIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEE11__get_valueB7v160000Ev(Larg0){
	return Larg0;
}
function __ZNKSt4lessIN13StreamNetwork11ServiceAddrEEclB7v160000ERKS1_S4_(Larg0,Larg1){
	return (__ZNK13StreamNetwork11ServiceAddrltERKS0_(Larg0,Larg1)|0)|0;
}
function __ZNK13StreamNetwork11ServiceAddrltERKS0_(Larg0,Larg1){
	var tmp0=0;
	tmp0=~~ +Larg0.a0.localeCompare(Larg1.a0);
	if((tmp0|0)<0)return 1|0;
	if((tmp0|0)!==0)return 0|0;
	return (Larg0.i1>>>0<Larg1.i1>>>0?1:0)|0;
}
function __ZNSt17__compressed_pairIjSt19__map_value_compareIN13StreamNetwork11ServiceAddrESt12__value_typeIS2_NS1_11AcceptQueueEESt4lessIS2_ELb1EEE6secondB7v160000Ev(Larg0){
	return __ZNSt22__compressed_pair_elemISt19__map_value_compareIN13StreamNetwork11ServiceAddrESt12__value_typeIS2_NS1_11AcceptQueueEESt4lessIS2_ELb1EELi1ELb1EE5__getB7v160000Ev(Larg0);
}
function __ZNSt22__compressed_pair_elemISt19__map_value_compareIN13StreamNetwork11ServiceAddrESt12__value_typeIS2_NS1_11AcceptQueueEESt4lessIS2_ELb1EELi1ELb1EE5__getB7v160000Ev(Larg0){
	return Larg0;
}
function __ZNSt16allocator_traitsISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEEE8allocateB7v160000ERS8_j(){
	return __ZNSaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPvEE8allocateB7v160000Ej();
}
function __ZNSt22__tree_node_destructorISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEEEC2B7v160000ERS8_b(Larg0,Larg1){
	Larg0.a0=Larg1;
	Larg0.i1=0;
}
function __ZNSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEEC2B7v160000ILb1EvEEPS7_NSt16__dependent_typeISt27__unique_ptr_deleter_sfinaeISA_EXT_EE20__good_rval_ref_typeE(Larg0,Larg1,Larg2){
	var tmp0=null;
	tmp0=[null];
	tmp0[0]=Larg1;
	__ZNSt17__compressed_pairIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEEC2B7v160000IRS8_SB_EEOT_OT0_(Larg0,tmp0,0,Larg2);
}
function __ZNSt16allocator_traitsISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvEEE9constructB7v160000ISt4pairIKS3_S4_EJRKSt21piecewise_construct_tSt5tupleIJRS3_EESH_IJEEEvvEEvRS8_PT_DpOT0_(Larg0,Larg1){
	__ZSt12construct_atB7v160000ISt4pairIKN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEJRKSt21piecewise_construct_tSt5tupleIJRS2_EES9_IJEEEPS5_EPT_SF_DpOT0_(Larg0,Larg1);
}
function __ZNSt10unique_ptrISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE11get_deleterB7v160000Ev(Larg0){
	return __ZNSt17__compressed_pairIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEE6secondB7v160000Ev(Larg0);
}
function __ZSt12construct_atB7v160000ISt4pairIKN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEJRKSt21piecewise_construct_tSt5tupleIJRS2_EES9_IJEEEPS5_EPT_SF_DpOT0_(Larg0,Larg1){
	var L$psroa$p01$p0$pcopyload=null,tmp1=null;
	L$psroa$p01$p0$pcopyload=Larg1.a0;
	tmp1={a0:null};
	tmp1.a0=L$psroa$p01$p0$pcopyload;
	__ZNSt4pairIKN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEEC2B7v160000IJRS1_EJEEESt21piecewise_construct_tSt5tupleIJDpT_EES8_IJDpT0_EE(Larg0,tmp1);
	return Larg0;
}
function __ZNSt4pairIKN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEEC2B7v160000IJRS1_EJEEESt21piecewise_construct_tSt5tupleIJDpT_EES8_IJDpT0_EE(Larg0,Larg1){
	__ZNSt4pairIKN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEEC2B7v160000IJRS1_EJEJLj0EEJEEESt21piecewise_construct_tRSt5tupleIJDpT_EERS8_IJDpT0_EESt15__tuple_indicesIJXspT1_EEESH_IJXspT2_EEE(Larg0,Larg1);
}
function __ZNSt4pairIKN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEEC2B7v160000IJRS1_EJEJLj0EEJEEESt21piecewise_construct_tRSt5tupleIJDpT_EERS8_IJDpT0_EESt15__tuple_indicesIJXspT1_EEESH_IJXspT2_EEE(Larg0,Larg1){
	var L$poptgepsqueezed14=null,L$poptgep4$poptgep$poptgep=null;
	L$poptgepsqueezed14=__ZSt3getB7v160000ILj0EJRN13StreamNetwork11ServiceAddrEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_(Larg1);
	Larg0.a0=L$poptgepsqueezed14.a0;
	Larg0.i1=L$poptgepsqueezed14.i1|0;
	L$poptgepsqueezed14=Larg0.a2;
	L$poptgepsqueezed14.a0=nullArray;
	L$poptgepsqueezed14.a0o=0;
	L$poptgep4$poptgep$poptgep=L$poptgepsqueezed14.a1;
	L$poptgep4$poptgep$poptgep.i0=0;
	L$poptgep4$poptgep$poptgep=L$poptgep4$poptgep$poptgep.a1;
	L$poptgep4$poptgep$poptgep.a0=null;
	L$poptgep4$poptgep$poptgep.a1=null;
	L$poptgepsqueezed14.a2=null;
	L$poptgep4$poptgep$poptgep=L$poptgepsqueezed14.a3;
	L$poptgep4$poptgep$poptgep.a0[0]=nullObj;
	L$poptgep4$poptgep$poptgep.a1[0]=nullObj;
	L$poptgep4$poptgep$poptgep.a2[0]=nullObj;
	L$poptgep4$poptgep$poptgep.a3.a0[0]=nullObj;
	L$poptgep4$poptgep$poptgep.i4=0;
	L$poptgep4$poptgep$poptgep.a5[0]=0;
	__ZN13StreamNetwork11AcceptQueueC2Ev(L$poptgepsqueezed14);
}
function __ZSt3getB7v160000ILj0EJRN13StreamNetwork11ServiceAddrEEERNSt13tuple_elementIXT_ESt5tupleIJDpT0_EEE4typeERS7_(Larg0){
	return __ZNSt12__tuple_leafILj0ERN13StreamNetwork11ServiceAddrELb0EE3getB7v160000Ev(Larg0);
}
function __ZN13StreamNetwork11AcceptQueueC2Ev(Larg0){
	__ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEEC2Ev(Larg0);
	__ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EEC2B7v160000Ev(Larg0.a3);
}
function __ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEEC2Ev(Larg0){
	Larg0.a0=nullArray;
	Larg0.a0o=0;
	__ZNSt16coroutine_handleIvEC2B7v160000Ev(Larg0);
	__ZNSt8optionalIN13StreamNetwork11AcceptQueue7PendingEEC2B7v160000Ev(Larg0.a1);
	Larg0.a2=null;
}
function __ZNSt5dequeIN13StreamNetwork11AcceptQueue7PendingESaIS2_EEC2B7v160000Ev(Larg0){
	var tmp0=null;
	__ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EEC2Ev(Larg0);
	Larg0.i4=0;
	tmp0=[0];
	tmp0[0]=0;
	__ZNSt17__compressed_pairIjSaIN13StreamNetwork11AcceptQueue7PendingEEEC2B7v160000IiSt18__default_init_tagEEOT_OT0_(Larg0.a5,0,tmp0,0);
}
function __ZNSt14__split_bufferIPN13StreamNetwork11AcceptQueue7PendingESaIS3_EEC2Ev(Larg0){
	Larg0.a0[0]=nullObj;
	Larg0.a1[0]=nullObj;
	Larg0.a2[0]=nullObj;
	__ZNSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingESaIS3_EEC2B7v160000IDnSt18__default_init_tagEEOT_OT0_(Larg0.a3);
}
function __ZNSt17__compressed_pairIjSaIN13StreamNetwork11AcceptQueue7PendingEEEC2B7v160000IiSt18__default_init_tagEEOT_OT0_(Larg0,Marg0,Larg1,Marg1){
	__ZNSt22__compressed_pair_elemIjLi0ELb0EEC2B7v160000IivEEOT_(Larg0,Marg0,Larg1,Marg1);
}
function __ZNSt17__compressed_pairIPPN13StreamNetwork11AcceptQueue7PendingESaIS3_EEC2B7v160000IDnSt18__default_init_tagEEOT_OT0_(Larg0){
	__ZNSt22__compressed_pair_elemIPPN13StreamNetwork11AcceptQueue7PendingELi0ELb0EEC2B7v160000IDnvEEOT_(Larg0);
}
function __ZNSt8optionalIN13StreamNetwork11AcceptQueue7PendingEEC2B7v160000Ev(Larg0){
	__ZNSt27__optional_move_assign_baseIN13StreamNetwork11AcceptQueue7PendingELb1EEC2Ev(Larg0);
}
function __ZNSt27__optional_move_assign_baseIN13StreamNetwork11AcceptQueue7PendingELb1EEC2Ev(Larg0){
	__ZNSt27__optional_copy_assign_baseIN13StreamNetwork11AcceptQueue7PendingELb1EEC2Ev(Larg0);
}
function __ZNSt27__optional_copy_assign_baseIN13StreamNetwork11AcceptQueue7PendingELb1EEC2Ev(Larg0){
	__ZNSt20__optional_move_baseIN13StreamNetwork11AcceptQueue7PendingELb1EEC2Ev(Larg0);
}
function __ZNSt20__optional_move_baseIN13StreamNetwork11AcceptQueue7PendingELb1EEC2Ev(Larg0){
	__ZNSt20__optional_copy_baseIN13StreamNetwork11AcceptQueue7PendingELb1EEC2Ev(Larg0);
}
function __ZNSt20__optional_copy_baseIN13StreamNetwork11AcceptQueue7PendingELb1EEC2Ev(Larg0){
	__ZNSt23__optional_storage_baseIN13StreamNetwork11AcceptQueue7PendingELb0EEC2Ev(Larg0);
}
function __ZNSt23__optional_storage_baseIN13StreamNetwork11AcceptQueue7PendingELb0EEC2Ev(Larg0){
	__ZNSt24__optional_destruct_baseIN13StreamNetwork11AcceptQueue7PendingELb1EEC2B7v160000Ev(Larg0);
}
function __ZNSt24__optional_destruct_baseIN13StreamNetwork11AcceptQueue7PendingELb1EEC2B7v160000Ev(Larg0){
	Larg0.i0=0;
}
function __ZNSt12__tuple_leafILj0ERN13StreamNetwork11ServiceAddrELb0EE3getB7v160000Ev(Larg0){
	return Larg0.a0;
}
function __ZNSt17__compressed_pairIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvESt22__tree_node_destructorISaIS7_EEEC2B7v160000IRS8_SB_EEOT_OT0_(Larg0,Larg1,Marg1,Larg2){
	__ZNSt22__compressed_pair_elemIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvELi0ELb0EEC2B7v160000IRS8_vEEOT_(Larg0,Larg1,Marg1);
	__ZNSt22__compressed_pair_elemISt22__tree_node_destructorISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS3_11AcceptQueueEEPvEEELi1ELb0EEC2B7v160000ISA_vEEOT_(Larg0.a1,Larg2);
}
function __ZNSt22__compressed_pair_elemIPSt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPvELi0ELb0EEC2B7v160000IRS8_vEEOT_(Larg0,Larg1,Marg1){
	Larg0.a0[0]=Larg1[Marg1];
}
function __ZNSt22__compressed_pair_elemISt22__tree_node_destructorISaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS3_11AcceptQueueEEPvEEELi1ELb0EEC2B7v160000ISA_vEEOT_(Larg0,Larg1){
	Larg0.a0=Larg1.a0;
	Larg0.i1=Larg1.i1|0;
}
function __ZNSaISt11__tree_nodeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPvEE8allocateB7v160000Ej(){
	var tmp0=null;
	tmp0={a0:[null],a1:[null],a2:null,i3:0,a4:{a0:null,i1:0,a2:tmp0={a0:nullArray,a0o:0,a1:{i0:0,a1:tmp0={a0:null,a1:null}},a2:null,a3:tmp0={a0:[nullObj],a1:[nullObj],a2:[nullObj],a3:{a0:[nullObj]},i4:0,a5:[0]}}}};
	return tmp0;
}
function __ZNSt5tupleIJRN13StreamNetwork11ServiceAddrEEEC2B7v160000ISt4_AndLi0EEES2_(Larg0,Larg1){
	__ZNSt12__tuple_implISt15__tuple_indicesIJLj0EEEJRN13StreamNetwork11ServiceAddrEEEC2B7v160000IJLj0EEJS4_EJEJEJS4_EEES0_IJXspT_EEESt13__tuple_typesIJDpT0_EES0_IJXspT1_EEES8_IJDpT2_EEDpOT3_(Larg0,Larg1);
}
function __ZNSt12__tuple_implISt15__tuple_indicesIJLj0EEEJRN13StreamNetwork11ServiceAddrEEEC2B7v160000IJLj0EEJS4_EJEJEJS4_EEES0_IJXspT_EEESt13__tuple_typesIJDpT0_EES0_IJXspT1_EEES8_IJDpT2_EEDpOT3_(Larg0,Larg1){
	__ZNSt12__tuple_leafILj0ERN13StreamNetwork11ServiceAddrELb0EEC2B7v160000IS2_vEEOT_(Larg0,Larg1);
}
function __ZNSt12__tuple_leafILj0ERN13StreamNetwork11ServiceAddrELb0EEC2B7v160000IS2_vEEOT_(Larg0,Larg1){
	Larg0.a0=Larg1;
}
function __ZNSt3mapIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueESt4lessIS1_ESaISt4pairIKS1_S2_EEE4findB7v160000ERS6_(Larg0,Larg1,Larg2){
	var tmp0=null;
	tmp0={a0:null};
	__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE4findIS2_EESt15__tree_iteratorIS4_PSt11__tree_nodeIS4_PvElERKT_(tmp0,Larg1,Larg2);
	__ZNSt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEEC2B7v160000ESA_(Larg0,tmp0);
}
function __ZNSt3mapIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueESt4lessIS1_ESaISt4pairIKS1_S2_EEE3endB7v160000Ev(Larg0,Larg1){
	var tmp0=null;
	tmp0={a0:null};
	__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE3endB7v160000Ev(tmp0,Larg1);
	__ZNSt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEEC2B7v160000ESA_(Larg0,tmp0);
}
function __ZSteqB7v160000RKSt14__map_iteratorISt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS2_11AcceptQueueEEPSt11__tree_nodeIS5_PvElEESD_(Larg0,Larg1){
	return (__ZSteqB7v160000RKSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElESB_(Larg0,Larg1)|0)|0;
}
function __ZN6cheerp8CallbackIZN13StreamNetwork9TCPSocketEPN6client6StringEjEUlvE_EEPNS2_13EventListenerEOT_(){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN13StreamNetwork9TCPSocketEPN6client6StringEjEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS6_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS6_Efp_EEEOS6_(tmp0);
	tmp1=__ZN6cheerp7ClosureIFvvEEcvPN6client13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvvEED2Ev(tmp0);
	return tmp1;
}
function __ZN13StreamNetwork13cross_streamsEv(Larg0){
	var tmp0=null,tmp1=null,tmp2=null,tmp3=null,LmergedArray=null;
	tmp0=new TransformStream();
	tmp2=new TransformStream();
	tmp1=__ZN6client20PromiseWithResolversIPNS_4_AnyEE6createEv();
	tmp3={a0:null,a1:null,a2:null,a3:null,a4:null};
	LmergedArray=tmp0.readable;
	__ZN13StreamNetwork9TCPClientC2EPN6client14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamIS4_EEPNS1_20PromiseWithResolversIPNS1_4_AnyEEESE_(tmp3,LmergedArray,tmp2.writable,tmp1,tmp1);
	LmergedArray=[null,null];
	LmergedArray[0]=tmp3;
	tmp3={a0:null,a1:null,a2:null,a3:null,a4:null};
	tmp2=tmp2.readable;
	__ZN13StreamNetwork9TCPClientC2EPN6client14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamIS4_EEPNS1_20PromiseWithResolversIPNS1_4_AnyEEESE_(tmp3,tmp2,tmp0.writable,tmp1,tmp1);
	LmergedArray[1]=tmp3;
	__ZNSt4pairIPN13StreamNetwork9TCPClientES2_EC2B7v160000IRS2_S5_LPv0EEEOT_OT0_(Larg0,LmergedArray,0,LmergedArray,1);
}
function __ZSt3getB7v160000ILj0EPN13StreamNetwork9TCPClientES2_EONSt13tuple_elementIXT_ESt4pairIT0_T1_EE4typeEOS7_(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSt10__get_pairILj0EE3getB7v160000IPN13StreamNetwork9TCPClientES4_EEOT_OSt4pairIS5_T0_E(Larg0);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZSt3getB7v160000ILj1EPN13StreamNetwork9TCPClientES2_EONSt13tuple_elementIXT_ESt4pairIT0_T1_EE4typeEOS7_(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=__ZNSt10__get_pairILj1EE3getB7v160000IPN13StreamNetwork9TCPClientES4_EEOT0_OSt4pairIT_S5_E(Larg0);
	tmp1=oSlot;
	oSlot=tmp1;
	return tmp0;
}
function __ZN13StreamNetwork13makeTCPSocketEPNS_9TCPClientEPKN6client6StringEjS5_j(Larg0,Larg1,Larg2,Larg3,Larg4){
	var tmp0=null,tmp1=null,tmp2=null;
	tmp1={readable :Larg0.a0, writable :Larg0.a1, remoteAddress :Larg3, remotePort :Larg4, localAddress :Larg1, localPort :Larg2};
	tmp2=Larg0.a2.promise;
	tmp0=[null];
	tmp0[0]=tmp1;
	tmp1=tmp2.then(__ZN6cheerp8CallbackIZN13StreamNetwork13makeTCPSocketEPNS1_9TCPClientEPKN6client6StringEjS7_jEUlvE_EEPNS4_13EventListenerEOT_(tmp0,0));
	tmp2=Larg0.a3.promise;
	return {opened :tmp1, closed :tmp2, close :Larg0.a4};
}
function __ZN6cheerp8CallbackIZN13StreamNetwork13makeTCPSocketEPNS1_9TCPClientEPKN6client6StringEjS7_jEUlvE_EEPNS4_13EventListenerEOT_(Larg0,Marg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN13StreamNetwork13makeTCPSocketEPNS1_9TCPClientEPKN6client6StringEjS7_jEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS9_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS9_Efp_EEEOS9_(tmp0,Larg0,Marg0);
	tmp1=__ZN6cheerp7ClosureIFPN6client6ObjectEvEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFPN6client6ObjectEvEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIZN13StreamNetwork13makeTCPSocketEPNS1_9TCPClientEPKN6client6StringEjS7_jEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS9_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS9_Efp_EEEOS9_(Larg0,Larg1,Marg1){
	__ZN6cheerp13ClosureHelperIZN13StreamNetwork13makeTCPSocketEPNS1_9TCPClientEPKN6client6StringEjS7_jEUlvE_MS8_KFPNS4_6ObjectEvEE12make_closureEOS8_(Larg0,Larg1,Marg1);
}
function __ZN6cheerp7ClosureIFPN6client6ObjectEvEEcvPNS1_13EventListenerEEv(Larg0){
	var tmp0=null;
	if(Larg0.a1!==null){
		tmp0=[{a0:null,a1:null}];
		tmp0[0].a0=Larg0.a1;
		tmp0[0].a1=Larg0.a2;
		tmp0=cheerpCreateClosure(__ZN6cheerp7ClosureIFPN6client6ObjectEvEE14deleter_helperEPNS5_13DeleterHelperE,tmp0[0]);
		__ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE3addEPS2_PNS1_6ObjectE(Larg0.a0,tmp0);
		Larg0.a1=null;
	}
	return Larg0.a0;
}
function __ZN6cheerp7ClosureIFPN6client6ObjectEvEED2Ev(Larg0){
	var tmp0=null;
	tmp0=Larg0.a1;
	if(tmp0!==null)tmp0(Larg0.a2);
}
function __ZN6cheerp7ClosureIFPN6client6ObjectEvEE14deleter_helperEPNS5_13DeleterHelperE(Larg0){
	Larg0.a0(Larg0.a1);
}
function __ZN6cheerp13ClosureHelperIZN13StreamNetwork13makeTCPSocketEPNS1_9TCPClientEPKN6client6StringEjS7_jEUlvE_MS8_KFPNS4_6ObjectEvEE12make_closureEOS8_(Larg0,Larg1,Marg1){
	__ZN6cheerp7ClosureIFPN6client6ObjectEvEEC2IZN13StreamNetwork13makeTCPSocketEPNS7_9TCPClientEPKNS1_6StringEjSC_jEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISE_PS4_EE5valueEvE4typeEPNSH_IXntsrNS5_13_must_destroyISE_EE5valueEvE4typeE(Larg0,Larg1,Marg1);
}
function __ZN6cheerp7ClosureIFPN6client6ObjectEvEEC2IZN13StreamNetwork13makeTCPSocketEPNS7_9TCPClientEPKNS1_6StringEjSC_jEUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISE_PS4_EE5valueEvE4typeEPNSH_IXntsrNS5_13_must_destroyISE_EE5valueEvE4typeE(Larg0,Larg1,Marg1){
	var tmp0=null,tmp1=null;
	tmp0=[null];
	tmp0[0]=Larg1[Marg1];
	tmp1=cheerpCreateClosureSplit(__ZN6cheerp12InvokeHelperIPN6client6ObjectEE6invokeIZN13StreamNetwork13makeTCPSocketEPNS6_9TCPClientEPKNS1_6StringEjSB_jEUlvE_JEEES3_PT_DpT0_,tmp0,0);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIPN6client6ObjectEE6invokeIZN13StreamNetwork13makeTCPSocketEPNS6_9TCPClientEPKNS1_6StringEjSB_jEUlvE_JEEES3_PT_DpT0_(Larg0,Marg0){
	return __ZZN13StreamNetwork13makeTCPSocketEPNS_9TCPClientEPKN6client6StringEjS5_jENKUlvE_clEv(Larg0,Marg0);
}
function __ZZN13StreamNetwork13makeTCPSocketEPNS_9TCPClientEPKN6client6StringEjS5_jENKUlvE_clEv(Larg0,Marg0){
	return Larg0[Marg0];
}
function __ZNSt10__get_pairILj1EE3getB7v160000IPN13StreamNetwork9TCPClientES4_EEOT0_OSt4pairIT_S5_E(Larg0){
	oSlot=0;
	return Larg0.a1;
}
function __ZNSt10__get_pairILj0EE3getB7v160000IPN13StreamNetwork9TCPClientES4_EEOT_OSt4pairIS5_T0_E(Larg0){
	oSlot=0;
	return Larg0.a0;
}
function __ZN13StreamNetwork9TCPClientC2EPN6client14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamIS4_EEPNS1_20PromiseWithResolversIPNS1_4_AnyEEESE_(Larg0,Larg1,Larg2,Larg3,Larg4){
	var tmp0=null;
	Larg0.a0=Larg1;
	Larg0.a1=Larg2;
	Larg0.a2=Larg3;
	Larg0.a3=Larg4;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	Larg0.a4=__ZN6cheerp8CallbackIZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS3_10Uint8ArrayEEEPNS3_14WritableStreamIS6_EEPNS3_20PromiseWithResolversIPNS3_4_AnyEEESG_EUlvE_EEPNS3_13EventListenerEOT_(tmp0);
}
function __ZNSt4pairIPN13StreamNetwork9TCPClientES2_EC2B7v160000IRS2_S5_LPv0EEEOT_OT0_(Larg0,Larg1,Marg1,Larg2,Marg2){
	Larg0.a0[0]=Larg1[Marg1];
	Larg0.a1[0]=Larg2[Marg2];
}
function __ZN6cheerp8CallbackIZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS3_10Uint8ArrayEEEPNS3_14WritableStreamIS6_EEPNS3_20PromiseWithResolversIPNS3_4_AnyEEESG_EUlvE_EEPNS3_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS3_10Uint8ArrayEEEPNS3_14WritableStreamIS6_EEPNS3_20PromiseWithResolversIPNS3_4_AnyEEESG_EUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISI_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISI_Efp_EEEOSI_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS3_10Uint8ArrayEEEPNS3_14WritableStreamIS6_EEPNS3_20PromiseWithResolversIPNS3_4_AnyEEESG_EUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISI_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISI_Efp_EEEOSI_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS3_10Uint8ArrayEEEPNS3_14WritableStreamIS6_EEPNS3_20PromiseWithResolversIPNS3_4_AnyEEESG_EUlvE_MSH_KFPNS3_7PromiseISE_EEvEE12make_closureEOSH_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS3_10Uint8ArrayEEEPNS3_14WritableStreamIS6_EEPNS3_20PromiseWithResolversIPNS3_4_AnyEEESG_EUlvE_MSH_KFPNS3_7PromiseISE_EEvEE12make_closureEOSH_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEEC2IZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISE_EEPNS1_20PromiseWithResolversIS4_EESM_EUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISO_PS7_EE5valueEvE4typeEPNSR_IXntsrNS8_13_must_destroyISO_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFPN6client7PromiseIPNS1_4_AnyEEEvEEC2IZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISE_EEPNS1_20PromiseWithResolversIS4_EESM_EUlvE_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISO_PS7_EE5valueEvE4typeEPNSR_IXntsrNS8_13_must_destroyISO_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISD_EEPNS1_20PromiseWithResolversIS4_EESL_EUlvE_JEEES6_PT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIPN6client7PromiseIPNS1_4_AnyEEEE6invokeIZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISD_EEPNS1_20PromiseWithResolversIS4_EESL_EUlvE_JEEES6_PT_DpT0_(Larg0){
	return __ZZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamIS4_EEPNS1_20PromiseWithResolversIPNS1_4_AnyEEESE_ENKUlvE_clEv(Larg0);
}
function __ZZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamIS4_EEPNS1_20PromiseWithResolversIPNS1_4_AnyEEESE_ENKUlvE_clEv(Larg0){
	var L$poptgepsqueezed8=null,tmp1=null,tmp2=null,tmp3=null;
	tmp1=Larg0.a0;
	tmp2=create__ZZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamIS4_EEPNS1_20PromiseWithResolversIPNS1_4_AnyEEESE_ENKUlvE_clEv$pFrame({a0:null,a1:null,a2:tmp2={a0:null},a3:null,a4:tmp2={a0:null,a1:null,a2:nullArray},i5:0,a6:tmp2={i0:0},a7:tmp2={i0:0}}).a;
	tmp3=tmp2[0];
	tmp3.a0=__ZZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamIS4_EEPNS1_20PromiseWithResolversIPNS1_4_AnyEEESE_ENKUlvE_clEv$presume;
	tmp3.a1=__ZZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamIS4_EEPNS1_20PromiseWithResolversIPNS1_4_AnyEEESE_ENKUlvE_clEv$pdestroy;
	tmp3.a3=tmp1;
	tmp1=__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS0_14ReadableStreamIPNS0_10Uint8ArrayEEEPNS0_14WritableStreamISA_EEPNS0_20PromiseWithResolversIS3_EESI_EUlvE_EE12promise_type17get_return_objectEv(tmp3.a2);
	L$poptgepsqueezed8=tmp3.a4;
	__ZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed8,tmp3.a3.a0.cancel());
	tmp3.i5=1;
	tmp3={a0:nullArray,a0o:0};
	__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISB_EEPNS1_20PromiseWithResolversIS4_EESJ_EUlvE_EE12promise_typeEE12from_addressB7v160000EPv(tmp3,tmp2,0);
	tmp2={a0:nullArray,a0o:0};
	__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISB_EEPNS1_20PromiseWithResolversIS4_EESJ_EUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(tmp2,tmp3);
	__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed8,tmp2);
	return tmp1;
}
function __ZZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamIS4_EEPNS1_20PromiseWithResolversIPNS1_4_AnyEEESE_ENKUlvE_clEv$presume(Larg0,Marg0){
	var L$poptgepsqueezed6=null,tmp1=null,tmp2=null;
	L$poptgepsqueezed6=Larg0[Marg0].a4;
	if((Larg0[Marg0].i5&3)!==0){
		__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(L$poptgepsqueezed6);
		Larg0[Marg0].a3.a3.resolve.call(null,null);
		__ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS0_14ReadableStreamIPNS0_10Uint8ArrayEEEPNS0_14WritableStreamISA_EEPNS0_20PromiseWithResolversIS3_EESI_EUlvE_EE12promise_type12return_valueES3_(Larg0[Marg0].a2);
	}else{
		__ZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EE(L$poptgepsqueezed6,Larg0[Marg0].a3.a0.cancel());
		Larg0[Marg0].i5=1;
		tmp1={a0:nullArray,a0o:0};
		__ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISB_EEPNS1_20PromiseWithResolversIS4_EESJ_EUlvE_EE12promise_typeEE12from_addressB7v160000EPv(tmp1,Larg0,Marg0);
		tmp2={a0:nullArray,a0o:0};
		__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISB_EEPNS1_20PromiseWithResolversIS4_EESJ_EUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(tmp2,tmp1);
		__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiter13await_suspendESt16coroutine_handleIvE(L$poptgepsqueezed6,tmp2);
	}
}
function __ZZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamIS4_EEPNS1_20PromiseWithResolversIPNS1_4_AnyEEESE_ENKUlvE_clEv$pdestroy(Larg0,Marg0){
	Larg0=Larg0[Marg0];
	var tmp0=0;
	tmp0=Larg0.i5|0;
	if(Larg0.a0!==null)if((tmp0&3)!==0)__ZZawIPN6client4_AnyEEDaRNS0_7PromiseIT_EEEN15promise_awaiterD2Ev(Larg0.a4);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS0_14ReadableStreamIPNS0_10Uint8ArrayEEEPNS0_14WritableStreamISA_EEPNS0_20PromiseWithResolversIS3_EESI_EUlvE_EE12promise_type17get_return_objectEv(Larg0){
	var tmp0=null;
	tmp0={a0:null};
	tmp0.a0=Larg0;
	return new Promise(_cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRKZN13StreamNetwork9TCPClientC1EPNS_14ReadableStreamIPNS_10Uint8ArrayEEEPNS_14WritableStreamISQ_EEPNS_20PromiseWithResolversIS3_EESY_EUlvE_EE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(tmp0));
}
function __ZNSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISB_EEPNS1_20PromiseWithResolversIS4_EESJ_EUlvE_EE12promise_typeEE12from_addressB7v160000EPv(Larg0,Larg1,Marg1){
	Larg0.a0=Larg1;
	Larg0.a0o=Marg1;
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISB_EEPNS1_20PromiseWithResolversIS4_EESJ_EUlvE_EE12promise_typeEEcvS_IvEB7v160000Ev(Larg0,Larg1){
	var tmp0=null,tmp1=0;
	tmp0=__ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISB_EEPNS1_20PromiseWithResolversIS4_EESJ_EUlvE_EE12promise_typeEE7addressB7v160000Ev(Larg1);
	tmp1=oSlot;
	__ZNSt16coroutine_handleIvE12from_addressB7v160000EPv(Larg0,tmp0,tmp1);
}
function __ZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS0_14ReadableStreamIPNS0_10Uint8ArrayEEEPNS0_14WritableStreamISA_EEPNS0_20PromiseWithResolversIS3_EESI_EUlvE_EE12promise_type12return_valueES3_(Larg0){
	Larg0.a0.call(null,null);
}
function __ZNKSt16coroutine_handleINSt16coroutine_traitsIPN6client7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISB_EEPNS1_20PromiseWithResolversIS4_EESJ_EUlvE_EE12promise_typeEE7addressB7v160000Ev(Larg0){
	var tmp0=null,tmp1=0;
	tmp0=Larg0.a0;
	tmp1=Larg0.a0o|0;
	oSlot=tmp1;
	return tmp0;
}
function _cheerpCreate_ZN6client9_FunctionIFvPNS0_IFvPNS_6_UnionIJPNS_4_AnyEPNS_11PromiseLikeIS3_EEEEEEEEPNS0_IFvS3_EEEEEC2IZNSt16coroutine_traitsIPNS_7PromiseIS3_EEJRKZN13StreamNetwork9TCPClientC1EPNS_14ReadableStreamIPNS_10Uint8ArrayEEEPNS_14WritableStreamISQ_EEPNS_20PromiseWithResolversIS3_EESY_EUlvE_EE12promise_type17get_return_objectEvEUlPNS_8FunctionEE_vEEOT_(Larg0){
	return __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS2_14ReadableStreamIPNS2_10Uint8ArrayEEEPNS2_14WritableStreamISC_EEPNS2_20PromiseWithResolversIS5_EESK_EUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0);
}
function __ZN6cheerp8CallbackIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS2_14ReadableStreamIPNS2_10Uint8ArrayEEEPNS2_14WritableStreamISC_EEPNS2_20PromiseWithResolversIS5_EESK_EUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEPNS2_13EventListenerEOT_(Larg0){
	var tmp0=null,tmp1=null;
	tmp0={a0:null,a1:null,a2:null};
	__ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS2_14ReadableStreamIPNS2_10Uint8ArrayEEEPNS2_14WritableStreamISC_EEPNS2_20PromiseWithResolversIS5_EESK_EUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISU_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISU_Efp_EEEOSU_(tmp0,Larg0);
	tmp1=__ZN6cheerp7ClosureIFvPN6client8FunctionEEEcvPNS1_13EventListenerEEv(tmp0);
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEED2Ev(tmp0);
	return tmp1;
}
function __ZN6cheerp12make_closureIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS2_14ReadableStreamIPNS2_10Uint8ArrayEEEPNS2_14WritableStreamISC_EEPNS2_20PromiseWithResolversIS5_EESK_EUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceISU_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardISU_Efp_EEEOSU_(Larg0,Larg1){
	__ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS2_14ReadableStreamIPNS2_10Uint8ArrayEEEPNS2_14WritableStreamISC_EEPNS2_20PromiseWithResolversIS5_EESK_EUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSS_KFvSR_EE12make_closureEST_(Larg0,Larg1);
}
function __ZN6cheerp13ClosureHelperIRZNSt16coroutine_traitsIPN6client7PromiseIPNS2_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS2_14ReadableStreamIPNS2_10Uint8ArrayEEEPNS2_14WritableStreamISC_EEPNS2_20PromiseWithResolversIS5_EESK_EUlvE_EE12promise_type17get_return_objectEvEUlPNS2_8FunctionEE_MSS_KFvSR_EE12make_closureEST_(Larg0,Larg1){
	__ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISH_EEPNS1_20PromiseWithResolversISA_EESP_EUlvE_EE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISX_PS4_EE5valueEvE4typeEPNS10_IXntsrNS5_13_must_destroyISX_EE5valueEvE4typeE(Larg0,Larg1);
}
function __ZN6cheerp7ClosureIFvPN6client8FunctionEEEC2IRZNSt16coroutine_traitsIPNS1_7PromiseIPNS1_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS1_14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamISH_EEPNS1_20PromiseWithResolversISA_EESP_EUlvE_EE12promise_type17get_return_objectEvEUlS3_E_EEOT_PNS_7utility9enable_ifIXntsr6cheerp7utility14is_convertibleISX_PS4_EE5valueEvE4typeEPNS10_IXntsrNS5_13_must_destroyISX_EE5valueEvE4typeE(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[{a0:null}];
	tmp0[0].a0=Larg1.a0;
	tmp1=cheerpCreateClosure(__ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS4_14ReadableStreamIPNS4_10Uint8ArrayEEEPNS4_14WritableStreamISE_EEPNS4_20PromiseWithResolversIS7_EESM_EUlvE_EE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JST_EEEvPT_DpT0_,tmp0[0]);
	Larg0.a0=tmp1;
	Larg0.a1=null;
	Larg0.a2=tmp0[0];
}
function __ZN6cheerp12InvokeHelperIvE6invokeIZNSt16coroutine_traitsIPN6client7PromiseIPNS4_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS4_14ReadableStreamIPNS4_10Uint8ArrayEEEPNS4_14WritableStreamISE_EEPNS4_20PromiseWithResolversIS7_EESM_EUlvE_EE12promise_type17get_return_objectEvEUlPNS4_8FunctionEE_JST_EEEvPT_DpT0_(Larg0,Larg1){
	__ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS0_14ReadableStreamIPNS0_10Uint8ArrayEEEPNS0_14WritableStreamISA_EEPNS0_20PromiseWithResolversIS3_EESI_EUlvE_EE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESP_(Larg0,Larg1);
}
function __ZZNSt16coroutine_traitsIPN6client7PromiseIPNS0_4_AnyEEEJRKZN13StreamNetwork9TCPClientC1EPNS0_14ReadableStreamIPNS0_10Uint8ArrayEEEPNS0_14WritableStreamISA_EEPNS0_20PromiseWithResolversIS3_EESI_EUlvE_EE12promise_type17get_return_objectEvENKUlPNS0_8FunctionEE_clESP_(Larg0,Larg1){
	Larg0.a0.a0=Larg1;
}
function __ZN6cheerp12make_closureIZN13StreamNetwork9TCPSocketEPN6client6StringEjEUlvE_EEDTclsr13ClosureHelperIT_DTadsr6cheerp7utility16remove_referenceIS6_E4typeEonclEEE12make_closureclgssr6cheerp7utilityE7forwardIS6_Efp_EEEOS6_(Larg0){
	__ZN6cheerp13ClosureHelperIZN13StreamNetwork9TCPSocketEPN6client6StringEjEUlvE_MS5_KFvvEE12make_closureEOS5_(Larg0);
}
function __ZN6cheerp13ClosureHelperIZN13StreamNetwork9TCPSocketEPN6client6StringEjEUlvE_MS5_KFvvEE12make_closureEOS5_(Larg0){
	__ZN6cheerp7ClosureIFvvEEC2IZN13StreamNetwork9TCPSocketEPN6client6StringEjEUlvE_EET_PNS_7utility9enable_ifIXsr6cheerp7utility14is_convertibleIS9_PS1_EE5valueEvE4typeE(Larg0);
}
function __ZN6cheerp7ClosureIFvvEEC2IZN13StreamNetwork9TCPSocketEPN6client6StringEjEUlvE_EET_PNS_7utility9enable_ifIXsr6cheerp7utility14is_convertibleIS9_PS1_EE5valueEvE4typeE(Larg0){
	var tmp0=null;
	tmp0=__ZZN13StreamNetwork9TCPSocketEPN6client6StringEjENUlvE_8__invokeEv;
	Larg0.a0=tmp0;
	Larg0.a1=null;
	Larg0.a2=null;
}
function __ZZN13StreamNetwork9TCPSocketEPN6client6StringEjENUlvE_8__invokeEv(){
}
function __ZSteqB7v160000RKSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElESB_(Larg0,Larg1){
	return (Larg0.a0===Larg1.a0?1:0)|0;
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE3endB7v160000Ev(Larg0,Larg1){
	__ZNSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEC2B7v160000EPSt15__tree_end_nodeIPSt16__tree_node_baseIS6_EE(Larg0,__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10__end_nodeB7v160000Ev(Larg1));
}
function __ZNSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEC2B7v160000EPSt15__tree_end_nodeIPSt16__tree_node_baseIS6_EE(Larg0,Larg1){
	Larg0.a0=Larg1;
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE4findIS2_EESt15__tree_iteratorIS4_PSt11__tree_nodeIS4_PvElERKT_(Larg0,Larg1,Larg2){
	var tmp0=null,tmp1=null;
	tmp0={a0:null};
	__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE13__lower_boundIS2_EESt15__tree_iteratorIS4_PSt11__tree_nodeIS4_PvElERKT_SG_PSt15__tree_end_nodeIPSt16__tree_node_baseISE_EE(tmp0,Larg1,Larg2,__ZNKSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE6__rootB7v160000Ev(Larg1),__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10__end_nodeB7v160000Ev(Larg1));
	tmp1={a0:null};
	__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE3endB7v160000Ev(tmp1,Larg1);
	a:{
		if(__ZStneB7v160000RKSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElESB_(tmp0,tmp1)|0)if(!(__ZNKSt19__map_value_compareIN13StreamNetwork11ServiceAddrESt12__value_typeIS1_NS0_11AcceptQueueEESt4lessIS1_ELb1EEclB7v160000ERKS1_RKS4_(__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10value_compB7v160000Ev(Larg1),Larg2,__ZNKSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEdeB7v160000Ev(tmp0))|0)){
			Larg0.a0=tmp0.a0;
			break a;
		}
		__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE3endB7v160000Ev(Larg0,Larg1);
	}
}
function __ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE13__lower_boundIS2_EESt15__tree_iteratorIS4_PSt11__tree_nodeIS4_PvElERKT_SG_PSt15__tree_end_nodeIPSt16__tree_node_baseISE_EE(Larg0,Larg1,Larg2,Larg3,Larg4){
	var tmp0=null,tmp1=null,L$pin=null;
	if(Larg3===null){
		__ZNSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEC2B7v160000EPSt15__tree_end_nodeIPSt16__tree_node_baseIS6_EE(Larg0,Larg4);
		return;
	}
	tmp0=__ZNSt6__treeISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEESt19__map_value_compareIS2_S4_St4lessIS2_ELb1EESaIS4_EE10value_compB7v160000Ev(Larg1);
	L$pin=Larg3;
	tmp1=Larg4;
	while(1){
		if(__ZNKSt19__map_value_compareIN13StreamNetwork11ServiceAddrESt12__value_typeIS1_NS0_11AcceptQueueEESt4lessIS1_ELb1EEclB7v160000ERKS4_RKS1_(tmp0,L$pin.a4,Larg2)|0){
			L$pin=L$pin.a1[0];
		}else{
			tmp1=L$pin;
			L$pin=L$pin.a0[0];
		}
		if(L$pin!==null){
			L$pin=L$pin;
			continue;
		}
		break;
	}
	__ZNSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEC2B7v160000EPSt15__tree_end_nodeIPSt16__tree_node_baseIS6_EE(Larg0,tmp1);
}
function __ZStneB7v160000RKSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElESB_(Larg0,Larg1){
	return ((__ZSteqB7v160000RKSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElESB_(Larg0,Larg1)|0)^1?1:0)|0;
}
function __ZNKSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElEdeB7v160000Ev(Larg0){
	return __ZNKSt15__tree_iteratorISt12__value_typeIN13StreamNetwork11ServiceAddrENS1_11AcceptQueueEEPSt11__tree_nodeIS4_PvElE8__get_npB7v160000Ev(Larg0).a4;
}
function __ZNKSt19__map_value_compareIN13StreamNetwork11ServiceAddrESt12__value_typeIS1_NS0_11AcceptQueueEESt4lessIS1_ELb1EEclB7v160000ERKS1_RKS4_(Larg0,Larg1,Larg2){
	return (__ZNKSt4lessIN13StreamNetwork11ServiceAddrEEclB7v160000ERKS1_S4_(Larg1,__ZNKSt12__value_typeIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEE11__get_valueB7v160000Ev(Larg2))|0)|0;
}
function __ZNKSt19__map_value_compareIN13StreamNetwork11ServiceAddrESt12__value_typeIS1_NS0_11AcceptQueueEESt4lessIS1_ELb1EEclB7v160000ERKS4_RKS1_(Larg0,Larg1,Larg2){
	return (__ZNKSt4lessIN13StreamNetwork11ServiceAddrEEclB7v160000ERKS1_S4_(__ZNKSt12__value_typeIN13StreamNetwork11ServiceAddrENS0_11AcceptQueueEE11__get_valueB7v160000Ev(Larg1),Larg2)|0)|0;
}
function __ZN20DirectSocketsNetwork9TCPSocketEPN6client6StringEj(Larg0,Larg1,Larg2){
	return new TCPSocket(Larg1, Larg2);
}
function __ZN20DirectSocketsNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsE(Larg0,Larg1,Larg2){
	return new TCPServerSocket(Larg1, Larg2);
}
function __ZN20DirectSocketsNetwork9UDPSocketEPN6client16UDPSocketOptionsE(Larg0,Larg1){
	return new UDPSocket(Larg1);
}
function __ZN20DirectSocketsNetwork2upEv(Larg0){
	return Promise.resolve(null);
}
function __ZN20DirectSocketsNetwork3newEv(){
	var tmp0=null;
	tmp0={i0:0};
	return tmp0;
}
function __ZN20DirectSocketsNetwork6deleteEv(Larg0){
}
function __ZN12DummyNetwork9TCPSocketEPN6client6StringEj(Larg0,Larg1,Larg2){
	return null;
}
function __ZN12DummyNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsE(Larg0,Larg1,Larg2){
	return null;
}
function __ZN12DummyNetwork9UDPSocketEPN6client16UDPSocketOptionsE(Larg0,Larg1){
	return null;
}
function __ZN12DummyNetwork2upEv(Larg0){
	return Promise.resolve(null);
}
function __ZN12DummyNetwork3newEv(){
	var tmp0=null;
	tmp0={i0:0};
	return tmp0;
}
function __ZN12DummyNetwork6deleteEv(Larg0){
}
function ___stdio_close(Larg0){
	var tmp0=0;
	tmp0=Larg0.i15|0;
	if((_aio_fd_cnt|0)!==0){
		___dummy_thread.i7=2;
		___aio_get_queue(tmp0);
	}
	return 0|0;
}
function ___stdio_write(Larg0,Larg1,Marg1,Larg2){
	var tmp0=null,tmp1=null,tmp2=0,L$poptgep$poptgep5$poptgepsqueezed=null,tmp4=0,tmp5=0,tmp6=0,Lgeptoindexphi1=0,tmp8=0;
	tmp0=[{a0:nullArray,a0o:0,i1:0},{a0:nullArray,a0o:0,i1:0}];
	L$poptgep$poptgep5$poptgepsqueezed=Larg0.a7;
	tmp4=Larg0.a7o|0;
	tmp0[0].a0=L$poptgep$poptgep5$poptgepsqueezed;
	tmp0[0].a0o=tmp4;
	tmp1=Larg0.a5;
	tmp5=Larg0.a5o|0;
	tmp5=(tmp5)-(tmp4)|0;
	tmp0[0].i1=tmp5;
	L$poptgep$poptgep5$poptgepsqueezed=tmp0[1];
	L$poptgep$poptgep5$poptgepsqueezed.a0=Larg1;
	L$poptgep$poptgep5$poptgepsqueezed.a0o=Marg1;
	L$poptgep$poptgep5$poptgepsqueezed.i1=Larg2;
	tmp4=___syscall_writev(tmp0,0,2)|0;
	if(tmp4>>>0>4294963200){
		___dummy_thread.i7=-tmp4|0;
		tmp4=-1;
	}
	tmp5=tmp5+Larg2|0;
	if((tmp5|0)!==(tmp4|0)){
		Lgeptoindexphi1=0;
		tmp6=2;
		while(1){
			if((tmp4|0)<0){
				Larg0.a4=nullArray;
				Larg0.a4o=0;
				Larg0.a7=nullArray;
				Larg0.a7o=0;
				Larg0.a5=nullArray;
				Larg0.a5o=0;
				Larg0.i0=Larg0.i0|32;
				if((tmp6|0)===2)return 0|0;
				tmp4=tmp0[Lgeptoindexphi1].i1|0;
				return Larg2-tmp4|0;
			}
			tmp5=tmp5-tmp4|0;
			tmp8=tmp0[Lgeptoindexphi1].i1|0;
			if(tmp4>>>0>tmp8>>>0){
				tmp4=tmp4-tmp8|0;
				tmp8=tmp0[(0+Lgeptoindexphi1|0)+1|0].i1|0;
				Lgeptoindexphi1=Lgeptoindexphi1+1|0;
				tmp6=tmp6-1|0;
			}
			L$poptgep$poptgep5$poptgepsqueezed=tmp0[Lgeptoindexphi1].a0;
			tmp2=tmp0[Lgeptoindexphi1].a0o|0;
			tmp0[Lgeptoindexphi1].a0=L$poptgep$poptgep5$poptgepsqueezed;
			tmp0[Lgeptoindexphi1].a0o=tmp2+tmp4|0;
			tmp0[Lgeptoindexphi1].i1=tmp8-tmp4|0;
			tmp4=___syscall_writev(tmp0,0+Lgeptoindexphi1|0,tmp6)|0;
			if(tmp4>>>0>4294963200){
				___dummy_thread.i7=-tmp4|0;
				tmp4=-1;
			}
			if((tmp5|0)!==(tmp4|0))continue;
			break;
		}
	}
	L$poptgep$poptgep5$poptgepsqueezed=Larg0.a11;
	tmp4=Larg0.a11o|0;
	tmp5=Larg0.i12|0;
	Larg0.a4=L$poptgep$poptgep5$poptgepsqueezed;
	Larg0.a4o=tmp4+tmp5|0;
	Larg0.a7=L$poptgep$poptgep5$poptgepsqueezed;
	Larg0.a7o=tmp4;
	Larg0.a5=L$poptgep$poptgep5$poptgepsqueezed;
	Larg0.a5o=tmp4;
	return Larg2|0;
}
function ___stdio_seek(Larg0,L$plow,L$phigh,Larg3){
	_cheerpSretSlot=-1;
	return  -1|0;
}
function ___aio_get_queue(Larg0){
	if((Larg0|0)<0)___dummy_thread.i7=9;
	else{
		___pthread_rwlock_timedrdlock();
		___pthread_rwlock_unlock();
	}
}
function ___stdout_write(Larg0,Larg1,Marg1,Larg2){
	Larg0.a9=___stdio_write;
	return (___stdio_write(Larg0,Larg1,Marg1,Larg2)|0)|0;
}
function ___lockfile(Larg0){
	var tmp0=0,L$ppn3=0,tmp2=0,tmp3=0;
	L$ppn3=Larg0.i19|0;
	tmp2=___dummy_thread.i6|0;
	if((L$ppn3& -1073741825|0)===(tmp2|0))return 0|0;
	tmp3=(L$ppn3|0)===0?tmp2|0:L$ppn3|0;
	Larg0.i19=tmp3;
	if((L$ppn3|0)===0)return 1|0;
	tmp2|=1073741824;
	Larg0.i19=(tmp3|0)===0?tmp2|0:tmp3|0;
	if((tmp3|0)===0)return 1|0;
	while(1){
		tmp0=L$ppn3|1073741824;
		a:{
			if((L$ppn3&1073741824|0)===0){
				Larg0.i19=(tmp3|0)===(L$ppn3|0)?tmp0|0:tmp3|0;
				if((tmp3|0)!==(L$ppn3|0))break a;
			}
			___syscall_futex(null,0,tmp0,0);
			___syscall_futex(null,0,tmp0,0);
			tmp3=Larg0.i19|0;
		}
		Larg0.i19=(tmp3|0)===0?tmp2|0:tmp3|0;
		if((tmp3|0)===0)return 1|0;
		L$ppn3=tmp3;
		continue;
	}
}
function ___pthread_rwlock_timedrdlock(){
	var L$psink13=0,tmp1=0;
	L$psink13=_maplock.a0[8]|0;
	tmp1=L$psink13&2147483647;
	a:if((tmp1|0)!==2147483646){
		if((tmp1|0)===2147483647){
			L$psink13=100;
			while(1){
				if((L$psink13|0)!==0)if((_maplock.a0[8]|0)!==0)if((_maplock.a0[9]|0)===0){
					L$psink13=L$psink13-1|0;
					continue;
				}
				break;
			}
			L$psink13=_maplock.a0[8]|0;
			tmp1=L$psink13&2147483647;
			if((tmp1|0)===2147483646)break a;
			if((tmp1|0)===2147483647)while(1){
				L$psink13=_maplock.a0[8]|0;
				if((L$psink13&2147483647|0)===2147483647){
					_maplock.a0[9]=(_maplock.a0[9]|0)+1|0;
					L$psink13|= -2147483648;
					_maplock.a0[8]=L$psink13;
					tmp1=___dummy_thread.i10|0;
					___dummy_thread.i10=tmp1&16776960|1;
					___syscall_futex(null,0,L$psink13,null);
					___syscall_futex(null,0,L$psink13,null);
					if((tmp1&255)<=2)___dummy_thread.i10=___dummy_thread.i10&16776960|tmp1&255;
					_maplock.a0[9]=(_maplock.a0[9]|0)-1|0;
				}
				L$psink13=_maplock.a0[8]|0;
				tmp1=L$psink13&2147483647;
				if((tmp1|0)===2147483646)break a;
				if((tmp1|0)===2147483647)continue;
				break;
			}
		}
		_maplock.a0[8]=L$psink13+1|0;
	}
}
function ___pthread_rwlock_unlock(){
	var tmp0=0,tmp1=0,tmp2=0,Lspec$pselect=0;
	tmp0=_maplock.a0[8]|0;
	tmp1=_maplock.a0[9]|0;
	tmp2=tmp0&2147483647;
	Lspec$pselect=(((tmp2-1073741825|0)^1073741822)+2& -3|0)!==0?tmp0-1|0:0|0;
	_maplock.a0[8]=Lspec$pselect;
	a:if((Lspec$pselect|0)===0){
		if((tmp1|0)===0)if((tmp0|0)>=0)break a;
		___syscall_futex(null,0,tmp2);
		___syscall_futex(null,0,tmp2);
	}
}
function _abort(){
	___syscall_tkill();
	;
}
function ___fwritex(Larg0,Marg0,Larg1,Larg2){
	var tmp0=0,tmp1=null,Lgeptoindexphi=0,L$ppre_0=null,L$ppre_1=0,tmp5=0;
	tmp1=Larg2.a4;
	Lgeptoindexphi=Larg2.a4o|0;
	a:{
		if(tmp1===nullArray&&Lgeptoindexphi===0){
			if(((___towrite(Larg2)|0)|0)!==0)break a;
			tmp1=Larg2.a4;
			Lgeptoindexphi=Larg2.a4o|0;
		}
		L$ppre_0=Larg2.a5;
		L$ppre_1=Larg2.a5o|0;
		if((Lgeptoindexphi)-(L$ppre_1)>>>0<Larg1>>>0)Larg2.a9(Larg2,Larg0,Marg0,Larg1)|0;
		else{
			if((Larg2.i20|0)>-1){
				Lgeptoindexphi=Larg1;
				while(1){
					if((Lgeptoindexphi|0)!==0){
						tmp5=Lgeptoindexphi-1|0;
						if((Larg0[Marg0+tmp5|0]&255)!==10){
							Lgeptoindexphi=tmp5;
							continue;
						}
						if((Larg2.a9(Larg2,Larg0,Marg0,Lgeptoindexphi)|0)>>>0<Lgeptoindexphi>>>0)break a;
						L$ppre_0=Larg2.a5;
						L$ppre_1=Larg2.a5o|0;
						tmp5=Larg1-Lgeptoindexphi|0;
					}else{
						Lgeptoindexphi=0;
						tmp5=Larg1;
					}
					break;
				}
			}else{
				Lgeptoindexphi=0;
				tmp5=Larg1;
			}
			if((tmp5|0)!==0){
				tmp0=L$ppre_1;
				tmp1=L$ppre_0;
				while(1){
					tmp1[tmp0]=Larg0[Marg0+Lgeptoindexphi|0]|0;
					if(L$ppre_0!==tmp1||(L$ppre_1+tmp5|0)!==(tmp0+1|0)){
						tmp0=tmp0+1|0;
						tmp1=tmp1;
						Lgeptoindexphi=Lgeptoindexphi+1|0;
						continue;
					}
					break;
				}
				L$ppre_0=Larg2.a5;
				L$ppre_1=Larg2.a5o|0;
			}
			Larg2.a5=L$ppre_0;
			Larg2.a5o=L$ppre_1+tmp5|0;
		}
	}
}
function ___unlockfile(Larg0){
	var tmp0=0;
	tmp0=Larg0.i19|0;
	Larg0.i19=0;
	if((tmp0&1073741824|0)!==0){
		___syscall_futex(null,0,1);
		___syscall_futex(null,0,1);
	}
}
function ___towrite(Larg0){
	var tmp0=null,tmp1=0,tmp2=0;
	tmp2=Larg0.i18|0;
	Larg0.i18=tmp2-1|tmp2;
	tmp2=Larg0.i0|0;
	if((tmp2&8|0)!==0){
		Larg0.i0=tmp2|32;
		return  -1|0;
	}
	Larg0.a2=nullArray;
	Larg0.a1=nullArray;
	tmp0=Larg0.a11;
	tmp2=Larg0.a11o|0;
	Larg0.a7=tmp0;
	Larg0.a7o=tmp2;
	Larg0.a5=tmp0;
	Larg0.a5o=tmp2;
	tmp1=Larg0.i12|0;
	Larg0.a4=tmp0;
	Larg0.a4o=tmp2+tmp1|0;
	return 0|0;
}
function _fflush(){
	var tmp0=0,tmp1=0,tmp2=null,tmp3=0,tmp4=null;
	if((___stdout_FILE.i19|0)>-1)tmp1=___lockfile(___stdout_FILE)|0;
	else{
		tmp1=0;
	}
	tmp2=___stdout_FILE.a5;
	tmp3=___stdout_FILE.a5o|0;
	tmp4=___stdout_FILE.a7;
	tmp0=___stdout_FILE.a7o|0;
	a:{
		b:{
			if(tmp2!==tmp4||tmp3!==tmp0){
				___stdout_FILE.a9(___stdout_FILE,nullArray,0,0)|0;
				tmp2=___stdout_FILE.a5;
				tmp3=___stdout_FILE.a5o|0;
				if(tmp2===nullArray&&tmp3===0){
					if((tmp1|0)!==0)break b;
					break a;
				}
			}
			tmp2=___stdout_FILE.a1;
			tmp4=___stdout_FILE.a2;
			if(tmp2!==tmp4||0!==0){
				tmp3=(0)-(0)|0;
				___stdout_FILE.a10(___stdout_FILE,tmp3,tmp3>>31,1)|0;
			}
			___stdout_FILE.a4=nullArray;
			___stdout_FILE.a4o=0;
			___stdout_FILE.a7=nullArray;
			___stdout_FILE.a7o=0;
			___stdout_FILE.a5=nullArray;
			___stdout_FILE.a5o=0;
			___stdout_FILE.a2=nullArray;
			___stdout_FILE.a1=nullArray;
			if((tmp1|0)===0)break a;
		}
		___unlockfile(___stdout_FILE);
	}
}
function ___vfprintf(Larg0,Marg0){
	Larg0={d:Larg0,o:Marg0};
	var LmergedArray=null,tmp1=null,tmp2=null,tmp3=0,Lgeptoindexphi=0,Lallocadecay1=null,tmp6=null,tmp7=0;
	LmergedArray=[nullObj,nullObj];
	LmergedArray[0]=Larg0;
	tmp1=new Int32Array(10);
	Lgeptoindexphi=0;
	while(1){
		tmp1[Lgeptoindexphi]=0;
		Lgeptoindexphi=Lgeptoindexphi+1|0;
		if(tmp1!==tmp1||10!==(0+Lgeptoindexphi|0))continue;
		break;
	}
	Lallocadecay1=createArray_struct$p_Z3arg(10);
	Lallocadecay1=Lallocadecay1[0];
	tmp2=new Uint8Array(80);
	LmergedArray[1]={d:LmergedArray[0].d,o:LmergedArray[0].o};
	if(((_printf_core(null,LmergedArray[1],Lallocadecay1,tmp1[0])|0)|0)>=0){
		if((___stderr_FILE.i19|0)>-1)Lgeptoindexphi=___lockfile(___stderr_FILE)|0;
		else{
			Lgeptoindexphi=0;
		}
		tmp3=___stderr_FILE.i0|0;
		if((___stderr_FILE.i18|0)<1)___stderr_FILE.i0=tmp3& -33;
		a:{
			b:{
				if((___stderr_FILE.i12|0)!==0){
					tmp6=___stderr_FILE.a4;
					tmp7=___stderr_FILE.a4o|0;
					if(tmp6!==nullArray||tmp7!==0){
						tmp7=0;
						tmp6=nullArray;
						break b;
					}
					tmp7=0;
					tmp6=nullArray;
				}else{
					tmp6=___stderr_FILE.a11;
					tmp7=___stderr_FILE.a11o|0;
					___stderr_FILE.a11=tmp2;
					___stderr_FILE.a11o=0;
					___stderr_FILE.i12=80;
					___stderr_FILE.a4=nullArray;
					___stderr_FILE.a4o=0;
					___stderr_FILE.a7=nullArray;
					___stderr_FILE.a7o=0;
					___stderr_FILE.a5=nullArray;
					___stderr_FILE.a5o=0;
				}
				if(((___towrite(___stderr_FILE)|0)|0)!==0)break a;
			}
			_printf_core(___stderr_FILE,LmergedArray[1],Lallocadecay1,tmp1[0])|0;
		}
		if(tmp6!==nullArray||tmp7!==0){
			___stderr_FILE.a9(___stderr_FILE,nullArray,0,0)|0;
			___stderr_FILE.a11=tmp6;
			___stderr_FILE.a11o=tmp7;
			___stderr_FILE.i12=0;
			___stderr_FILE.a4=nullArray;
			___stderr_FILE.a4o=0;
			___stderr_FILE.a7=nullArray;
			___stderr_FILE.a7o=0;
			___stderr_FILE.a5=nullArray;
			___stderr_FILE.a5o=0;
		}
		___stderr_FILE.i0=___stderr_FILE.i0|tmp3&32;
		if((Lgeptoindexphi|0)!==0)___unlockfile(___stderr_FILE);
	}
	LmergedArray[1]=null;
}
function _printf_core(Larg0,Larg1,Larg2,Larg3){
	var tmp0=null,tmp1=null,tmp2=0,Lgeptoindexphi8=0,Lsmax_select5=0,tmp5=0,tmp6=0,Lgeptoindexphi=0,Lgeptoindexphi25=0,L$poptgep32$poptgep$poptgepsqueezed=null,tmp10=null,Lsub51=0,LsubSel=0,tmp13=0;
	tmp0={a0:new Int32Array(2),d1:-0.,a2:nullArray,a2o:0};
	tmp1=new Uint8Array(40);
	tmp2=Larg0===null?1:0;
	tmp5=0;
	Lsmax_select5=0;
	Lgeptoindexphi8=0;
	a:while(1){
		while(1){
			if((Lsmax_select5|0)<=(2147483647-tmp5|0)){
				tmp5=tmp5+Lsmax_select5|0;
				tmp6=_$pstr$p105[Lgeptoindexphi8]|0;
				if((tmp6&255)===0)return (tmp2?0|0:tmp5|0)|0;
				Lgeptoindexphi=Lgeptoindexphi8;
				while(1){
					if((tmp6&255)!==0)if((tmp6&255)!==37){
						Lgeptoindexphi=Lgeptoindexphi+1|0;
						tmp6=_$pstr$p105[Lgeptoindexphi]|0;
						continue;
					}
					break;
				}
				Lsmax_select5=(0+Lgeptoindexphi|0)-(0+Lgeptoindexphi8|0)|0;
				tmp6=2147483647-tmp5|0;
				if((Lsmax_select5|0)<=(tmp6|0)){
					if(!(tmp2))if((Larg0.i0&32|0)===0)___fwritex(_$pstr$p105,0+Lgeptoindexphi8|0,Lsmax_select5,Larg0);
					if((Lsmax_select5|0)!==0){
						Lgeptoindexphi8=Lgeptoindexphi;
						continue;
					}
					if(tmp2)return 0|0;
					Lgeptoindexphi25=_$pstr$p105[(0+Lgeptoindexphi|0)+1|0]|0;
					_pop_arg(tmp0,_states$p805[(Lgeptoindexphi25<<24>>24)-65|0]|0,Larg1);
					if((_$pstr$p105[(0+Lgeptoindexphi|0)+1|0]|0)===115){
						L$poptgep32$poptgep$poptgepsqueezed=tmp0.a2;
						Lgeptoindexphi25=tmp0.a2o|0;
						tmp10=L$poptgep32$poptgep$poptgepsqueezed!==nullArray||Lgeptoindexphi25!==0?L$poptgep32$poptgep$poptgepsqueezed:_$pstr$p2$p809;
						Lsub51=L$poptgep32$poptgep$poptgepsqueezed!==nullArray||Lgeptoindexphi25!==0?Lgeptoindexphi25:0;
						if(0){
							Lgeptoindexphi25=0;
						}else{
							LsubSel=2147483647;
							Lgeptoindexphi25=0;
							while(1){
								if((tmp10[Lsub51+Lgeptoindexphi25|0]&255)!==0){
									LsubSel=LsubSel-1|0;
									if((LsubSel|0)!==0){
										Lgeptoindexphi25=Lgeptoindexphi25+1|0;
										continue;
									}
									Lgeptoindexphi25=2147483647;
								}else{
									Lgeptoindexphi25=(Lsub51+Lgeptoindexphi25|0)-(Lsub51)|0;
								}
								break;
							}
						}
						if((tmp10[Lsub51+Lgeptoindexphi25|0]&255)!==0)break a;
						LsubSel=Lsub51+Lgeptoindexphi25|0;
						L$poptgep32$poptgep$poptgepsqueezed=tmp10;
						Lgeptoindexphi8=(Lsub51+Lgeptoindexphi25|0)-(Lsub51)|0;
						Lgeptoindexphi25=0;
					}else{
						L$poptgep32$poptgep$poptgepsqueezed=tmp0.a0;
						Lsub51=L$poptgep32$poptgep$poptgepsqueezed[0]|0;
						LsubSel=L$poptgep32$poptgep$poptgepsqueezed[1]|0;
						if((LsubSel|0)<0){
							LsubSel=(Lsub51|0)!==0?LsubSel^ -1|0:-LsubSel|0;
							Lsub51=-Lsub51|0;
							L$poptgep32$poptgep$poptgepsqueezed[0]=Lsub51;
							L$poptgep32$poptgep$poptgepsqueezed[1]=LsubSel;
							Lgeptoindexphi25=1;
						}else{
							Lgeptoindexphi25=0;
						}
						if((LsubSel|0)!==0){
							Lgeptoindexphi8=0;
							while(1){
								Lsmax_select5=___udivti3(Lsub51,LsubSel,10)|0;
								tmp13=_cheerpSretSlot|0;
								Lgeptoindexphi8=Lgeptoindexphi8-1|0;
								tmp1[40+Lgeptoindexphi8|0]=((__imul(Lsmax_select5,246)|0)+Lsub51|0)+48|0;
								if(LsubSel>>>0>9){
									Lsub51=Lsmax_select5;
									LsubSel=tmp13;
									continue;
								}
								break;
							}
							Lsub51=Lsmax_select5;
						}else{
							Lgeptoindexphi8=0;
						}
						if((Lsub51|0)!==0)while(1){
							LsubSel=(Lsub51>>>0)/10|0;
							Lgeptoindexphi8=Lgeptoindexphi8-1|0;
							tmp1[40+Lgeptoindexphi8|0]=((__imul(LsubSel,246)|0)+Lsub51|0)+48|0;
							if(Lsub51>>>0>=10){
								Lsub51=LsubSel;
								continue;
							}
							break;
						}
						if(0)break a;
						if(1){
							Lsub51=((40)+((L$poptgep32$poptgep$poptgepsqueezed[1]|L$poptgep32$poptgep$poptgepsqueezed[0]|0)===0?1:0)|0)-(40+Lgeptoindexphi8|0)|0;
							tmp10=tmp1;
							Lsmax_select5=Lsub51;
							Lsub51=40+Lgeptoindexphi8|0;
							Lgeptoindexphi8=(Lsmax_select5|0)>-1?Lsmax_select5|0: -1|0;
							L$poptgep32$poptgep$poptgepsqueezed=tmp1;
							LsubSel=40;
						}else{
							L$poptgep32$poptgep$poptgepsqueezed=tmp1;
							tmp10=tmp1;
							Lsub51=40;
							LsubSel=40;
							Lgeptoindexphi8=0;
						}
					}
					LsubSel=(LsubSel)-(Lsub51)|0;
					Lgeptoindexphi8=(Lgeptoindexphi8|0)>(LsubSel|0)?Lgeptoindexphi8|0:LsubSel|0;
					if((Lgeptoindexphi8|0)<=(2147483647-Lgeptoindexphi25|0)){
						tmp13=Lgeptoindexphi8+Lgeptoindexphi25|0;
						Lsmax_select5=(tmp13|0)>0?tmp13|0:0|0;
						if((Lsmax_select5|0)<=(tmp6|0)){
							_pad$p792(Larg0,32,Lsmax_select5,tmp13,0);
							if((Larg0.i0&32|0)===0)___fwritex(_$pstr$p790,0,Lgeptoindexphi25,Larg0);
							_pad$p792(Larg0,48,Lsmax_select5,tmp13,65536);
							_pad$p792(Larg0,48,Lgeptoindexphi8,LsubSel,0);
							if((Larg0.i0&32|0)===0)___fwritex(tmp10,Lsub51,LsubSel,Larg0);
							_pad$p792(Larg0,32,Lsmax_select5,tmp13,8192);
							Lgeptoindexphi8=Lgeptoindexphi+2|0;
							continue a;
						}
					}
				}
			}
			break;
		}
		break;
	}
	___dummy_thread.i7=75;
	return  -1|0;
}
function _pop_arg(Larg0,Larg1,Larg2){
	var L$poptgep26$poptgep$poptgepsqueezed=null,L$poptgep$poptgep$poptgepsqueezed=null,Lsext44=0,tmp3=0,tmp4=-0.;
	switch(Larg1|0){
		case 9:
		L$poptgep$poptgep$poptgepsqueezed=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=L$poptgep$poptgep$poptgepsqueezed===0?nullObj:L$poptgep$poptgep$poptgepsqueezed;
		Larg0.a2=L$poptgep$poptgep$poptgepsqueezed.d;
		Larg0.a2o=L$poptgep$poptgep$poptgepsqueezed.o;
		break;
		case 10:
		Lsext44=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44;
		L$poptgep$poptgep$poptgepsqueezed[1]=Lsext44>>31;
		break;
		case 11:
		Lsext44=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44;
		L$poptgep$poptgep$poptgepsqueezed[1]=0;
		break;
		case 13:
		Lsext44=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44;
		L$poptgep$poptgep$poptgepsqueezed[1]=Lsext44>>31;
		break;
		case 14:
		Lsext44=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44;
		L$poptgep$poptgep$poptgepsqueezed[1]=0;
		break;
		case 12:
		Lsext44=handleVAArg(Larg2);
		tmp3=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44;
		L$poptgep$poptgep$poptgepsqueezed[1]=tmp3;
		break;
		case 15:
		Lsext44=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		Lsext44<<=16;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44>>16;
		L$poptgep$poptgep$poptgepsqueezed[1]=Lsext44>>31;
		break;
		case 16:
		Lsext44=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44&65535;
		L$poptgep$poptgep$poptgepsqueezed[1]=0;
		break;
		case 17:
		Lsext44=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		Lsext44<<=24;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44>>24;
		L$poptgep$poptgep$poptgepsqueezed[1]=Lsext44>>31;
		break;
		case 18:
		Lsext44=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44&255;
		L$poptgep$poptgep$poptgepsqueezed[1]=0;
		break;
		case 19:
		Lsext44=handleVAArg(Larg2);
		tmp3=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44;
		L$poptgep$poptgep$poptgepsqueezed[1]=tmp3;
		break;
		case 20:
		Lsext44=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44;
		L$poptgep$poptgep$poptgepsqueezed[1]=0;
		break;
		case 21:
		Lsext44=handleVAArg(Larg2);
		tmp3=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44;
		L$poptgep$poptgep$poptgepsqueezed[1]=tmp3;
		break;
		case 22:
		Lsext44=handleVAArg(Larg2);
		tmp3=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44;
		L$poptgep$poptgep$poptgepsqueezed[1]=tmp3;
		break;
		case 23:
		Lsext44=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=Larg0.a0;
		L$poptgep$poptgep$poptgepsqueezed[0]=Lsext44;
		L$poptgep$poptgep$poptgepsqueezed[1]=Lsext44>>31;
		break;
		case 24:
		L$poptgep$poptgep$poptgepsqueezed=handleVAArg(Larg2);
		L$poptgep$poptgep$poptgepsqueezed=L$poptgep$poptgep$poptgepsqueezed===0?nullObj:L$poptgep$poptgep$poptgepsqueezed;
		L$poptgep26$poptgep$poptgepsqueezed=Larg0.a0;
		L$poptgep26$poptgep$poptgepsqueezed[0]=(L$poptgep$poptgep$poptgepsqueezed.o);
		L$poptgep26$poptgep$poptgepsqueezed[1]=0;
		break;
		case 25:
		tmp4=handleVAArg(Larg2);
		Larg0.d1=tmp4;
		break;
		case 26:
		tmp4=handleVAArg(Larg2);
		Larg0.d1=tmp4;
		break;
		default:
	}
}
function _pad$p792(Larg0,Larg1,Larg2,Larg3,Larg4){
	var tmp0=null,Lsmin_select=0,tmp2=0,Lgeptoindexphi=0;
	tmp0=new Uint8Array(256);
	if((Larg2|0)>(Larg3|0))if((Larg4&73728|0)===0){
		tmp2=Larg2-Larg3|0;
		Lsmin_select=tmp2>>>0<256?tmp2|0:256|0;
		if((Lsmin_select|0)!==0){
			Lgeptoindexphi=0;
			while(1){
				tmp0[Lgeptoindexphi]=Larg1;
				Lgeptoindexphi=Lgeptoindexphi+1|0;
				if(tmp0!==tmp0||Lsmin_select!==(0+Lgeptoindexphi|0))continue;
				break;
			}
		}
		if(tmp2>>>0>255)while(1){
			if((Larg0.i0&32|0)===0)___fwritex(tmp0,0,256,Larg0);
			tmp2=tmp2-256|0;
			if(tmp2>>>0>255)continue;
			break;
		}
		if((Larg0.i0&32|0)===0)___fwritex(tmp0,0,tmp2,Larg0);
	}
}
function ___assert_fail(Larg0,Marg0,Larg1,Marg1,Larg2,Larg3,Marg3){
	Larg0={d:Larg0,o:Marg0};
	Larg1={d:Larg1,o:Marg1};
	Larg3={d:Larg3,o:Marg3};
	_fflush();
	___fprintf(null,nullObj,Larg0,Larg1,Larg3,Larg2);
	_abort();
	;
}
function ___fprintf(Larg0,Larg1){
	var tmp0=null,tmp1=null;
	tmp0=[nullObj];
	tmp0[0]={d:arguments,o:___fprintf.length};
	tmp1=tmp0[0];
	___vfprintf(tmp1.d,tmp1.o);
	tmp0[0]=null;
}
function ___cheerp_init_tls(){
	var tmp0=null,tmp1=0;
	tmp0=_main_tls$p1.a1;
	tmp1=_main_tls$p1.a1o|0;
	if(tmp0===nullArray&&tmp1===0){
		tmp1=___tlsImage|0;
		_main_tls$p1.a1=nullArray;
		_main_tls$p1.a1o=tmp1>>0;
		tmp1=___tlsImageSize|0;
		_main_tls$p1.i3=tmp1;
		_main_tls$p1.i2=___tlsImageSize|0;
		_main_tls$p1.i4=16;
		_main_tls$p1.i5=tmp1;
		___libc.i6=1;
		___libc.a3=_main_tls$p1;
		___libc.i5=16;
		___libc.i4=tmp1+135|0;
		___dummy_thread.a0=___dummy_thread;
		___libc.i0=___libc.i0& -256|1;
		___dummy_thread.i8=2;
		___dummy_thread.i6=1;
		___dummy_thread.a22=___libc.a8[0];
		___dummy_thread.a19.a0[0]={d:___dummy_thread.a19.a0,o:0};
		___dummy_thread.i4=0;
		___dummy_thread.a2=___dummy_thread;
		___dummy_thread.a3=___dummy_thread;
	}
}
function ___syscall_tkill(){
	__ZN12sys_internal5tkillEii();
	;
}
function __ZN12sys_internal5tkillEii(){
	___syscall_exit();
	;
}
function ___syscall_exit(){
	__ZN12_GLOBAL__N_111raiseSignalEi();
	;
}
function __ZN12_GLOBAL__N_111raiseSignalEi(){
	var tmp0=null;
	tmp0="Program exited with code ";
	tmp0=new CheerpException(tmp0.concat(String(71)),!!1,71);
	throw tmp0;
	;
}
function __ZL16read_nodejs_argsPKN6client6StringE(Larg0){
	var tmp0=null,tmp1=null,tmp2=null,tmp3=0;
	tmp0=_cheerpCreate_ZN6client6TArrayIPNS_6StringEEC2Ev();
	tmp1=(typeof process == 'undefined' ? [] : process.argv) || [];
	if(((tmp1.length)|0)!==0){
		tmp3=0;
		while(1){
			tmp2=tmp1[(+(tmp3>>>0))];
			if(tmp2.startsWith(Larg0))+tmp0.push(tmp2.substr((+((Larg0.length)|0))));
			tmp3=tmp3+1|0;
			if(tmp3>>>0<(tmp1.length)>>>0)continue;
			break;
		}
	}
	return tmp0;
}
function __ZL11read_to_bufPcjPKN6client6TArrayIPNS0_6StringEEEj(Larg0,Marg0,Larg1,Larg2,Larg3){
	var tmp0=0;
	if((Larg2.length)>>>0>Larg3>>>0){
		tmp0=__ZL14client_to_utf8PcjPKN6client6StringE(Larg0,Marg0,Larg1,Larg2[(+(Larg3>>>0))])|0;
		if(tmp0>>>0<Larg1>>>0)Larg0[Marg0+tmp0|0]=0;
		return tmp0+1|0;
	}
	return 0|0;
}
function __ZL14client_to_utf8PcjPKN6client6StringE(Larg0,Marg0,Larg1,Larg2){
	var tmp0=0,tmp1=0,Lgeptoindexphi1=0,tmp3=0,tmp4=0,L$psink=0;
	tmp0=Larg2.length;
	if((tmp0|0)===0)return 0|0;
	tmp4=0;
	tmp3=0;
	Lgeptoindexphi1=0;
	while(1){
		L$psink=Larg2.charCodeAt((+(tmp3>>>0)));
		a:{
			if((L$psink& -2048|0)===55296){
				tmp1=tmp3+1|0;
				if(tmp1>>>0<tmp0>>>0){
					tmp3=Larg2.charCodeAt((+(tmp1>>>0)));
					L$psink=((tmp3|L$psink)&1023)+65536|0;
					tmp3=tmp1;
				}else{
					L$psink=-1;
				}
			}else if(L$psink>>>0>1114111){
				L$psink=-1;
			}else{
				if(L$psink>>>0<128){
					if(tmp4>>>0<Larg1>>>0){
						Larg0[Marg0+Lgeptoindexphi1|0]=L$psink;
						Lgeptoindexphi1=Lgeptoindexphi1+1|0;
						L$psink=1;
						break a;
					}
					L$psink=1;
					break a;
				}
				if(L$psink>>>0<2048){
					if(tmp4+1>>>0<Larg1>>>0){
						Larg0[Marg0+Lgeptoindexphi1|0]=L$psink>>>6|192;
						Larg0[(Marg0+Lgeptoindexphi1|0)+1|0]=L$psink&63|128;
						Lgeptoindexphi1=Lgeptoindexphi1+2|0;
						L$psink=2;
						break a;
					}
					L$psink=2;
					break a;
				}
				if(L$psink>>>0<65536){
					if(tmp4+2>>>0<Larg1>>>0){
						Larg0[Marg0+Lgeptoindexphi1|0]=L$psink>>>12|224;
						Larg0[(Marg0+Lgeptoindexphi1|0)+1|0]=L$psink>>>6&63|128;
						Larg0[(Marg0+Lgeptoindexphi1|0)+2|0]=L$psink&63|128;
						Lgeptoindexphi1=Lgeptoindexphi1+3|0;
						L$psink=3;
						break a;
					}
					L$psink=3;
					break a;
				}
			}
			if(tmp4+3>>>0<Larg1>>>0){
				Larg0[Marg0+Lgeptoindexphi1|0]=L$psink>>>18|240;
				Larg0[(Marg0+Lgeptoindexphi1|0)+1|0]=L$psink>>>12&63|128;
				Larg0[(Marg0+Lgeptoindexphi1|0)+2|0]=L$psink>>>6&63|128;
				Larg0[(Marg0+Lgeptoindexphi1|0)+3|0]=L$psink&63|128;
				Lgeptoindexphi1=Lgeptoindexphi1+4|0;
				L$psink=4;
			}else{
				L$psink=4;
			}
		}
		tmp4=tmp4+L$psink|0;
		tmp3=tmp3+1|0;
		if(tmp3>>>0<tmp0>>>0)continue;
		break;
	}
	return tmp4|0;
}
function _cheerpCreate_ZN6client6TArrayIPNS_6StringEEC2Ev(){
	return new Array();
}
function ___syscall_main_environ(){
	var tmp0=0,tmp1=0,tmp2=0;
	tmp1=__ZL8buf_size|0;
	tmp2=0;
	while(1){
		tmp0=65536-tmp1|0;
		tmp1=__ZL8read_envPcjj(__ZL16argv_environ_buf,tmp1,tmp0,tmp2)|0;
		if((tmp1|0)!==0){
			if(tmp1>>>0>tmp0>>>0)_abort();
			;
			tmp1=(__ZL8buf_size|0)+tmp1|0;
			__ZL8buf_size=tmp1;
			tmp2=tmp2+1|0;
			if((tmp2|0)!==64)continue;
			_abort();
			;
		}
		break;
	}
}
function __ZL8read_envPcjj(Larg0,Marg0,Larg1,Larg2){
	var tmp0=null;
	if(__ZGVZL8read_envPcjjE14client_environ|0)return (__ZL11read_to_bufPcjPKN6client6TArrayIPNS0_6StringEEEj(Larg0,Marg0,Larg1,__ZZL8read_envPcjjE14client_environ,Larg2)|0)|0;
	tmp0=CHEERP_ENV;
	if(tmp0!==null)tmp0=CHEERP_ENV;
	else tmp0=__ZL16read_nodejs_argsPKN6client6StringE("--cheerp-env=");
	__ZZL8read_envPcjjE14client_environ=tmp0;
	__ZGVZL8read_envPcjjE14client_environ=1;
	return (__ZL11read_to_bufPcjPKN6client6TArrayIPNS0_6StringEEEj(Larg0,Marg0,Larg1,tmp0,Larg2)|0)|0;
}
function ___syscall_futex(Larg0,Larg1){
	var tmp0=null;
	tmp0=[nullObj];
	tmp0[0]={d:arguments,o:___syscall_futex.length};
	__ZN12sys_internal13futex_wrapperEPjiPc();
	tmp0[0]=null;
}
function __ZN12sys_internal13futex_wrapperEPjiPc(){
	__ZN12sys_internal19isBrowserMainThreadEv();
}
function __ZN12sys_internal19isBrowserMainThreadEv(){
	if((__ZZN12sys_internal19isBrowserMainThreadEvE16canUseAtomicWait|0)===0)__ZZN12sys_internal19isBrowserMainThreadEvE16canUseAtomicWait=_testUseAtomicWait()|0?1|0:2|0;
}
function _testUseAtomicWait(){
	return (_testUseAtomicWaitJS()|0)|0;
}
function _testUseAtomicWaitJS(){
	return ((((()=>{var ret;try{Atomics.wait(HEAP32,0,0,0);ret=true;}catch(e){ret=false;}return ret;})()|0)&1)!==0?1:0)|0;
}
function ___syscall_writev(Larg0,Marg0,Larg1){
	return (__ZN12_GLOBAL__N_117do_syscall_writevEPK5iovecl(Larg0,Marg0,Larg1)|0)|0;
}
function __ZN12_GLOBAL__N_117do_syscall_writevEPK5iovecl(Larg0,Marg0,Larg1){
	var tmp0=null,tmp1=null,L$plcssa=0,tmp3=0,tmp4=0,tmp5=0,tmp6=0;
	if(__ZGVZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE4curr|0){
		tmp0=__ZZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE4curr;
	}else{
		tmp0=String();
		__ZZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE4curr=tmp0;
		__ZGVZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE4curr=1;
	}
	tmp1=[null];
	__ZN12_GLOBAL__N_119CheerpStringBuilder9setStringEPN6client6StringE(tmp1,0,tmp0);
	if((Larg1|0)>0){
		tmp3=0;
		L$plcssa=0;
		while(1){
			tmp4=Larg0[Marg0+tmp3|0].i1|0;
			if((tmp4|0)!==0){
				L$plcssa=tmp4+L$plcssa|0;
				tmp0=Larg0[Marg0+tmp3|0].a0;
				tmp5=Larg0[Marg0+tmp3|0].a0o|0;
				if((tmp4|0)>0){
					tmp6=0;
					while(1){
						__ZN12_GLOBAL__N_119CheerpStringBuilder11processCharERjS1_h(tmp1,0,tmp0[tmp5+tmp6|0]|0);
						tmp6=tmp6+1|0;
						if((tmp6|0)!==(tmp4|0))continue;
						break;
					}
				}
			}
			tmp3=tmp3+1|0;
			if((tmp3|0)!==(Larg1|0))continue;
			break;
		}
	}else{
		L$plcssa=0;
	}
	tmp0=__ZN12_GLOBAL__N_119CheerpStringBuilder9getStringEv(tmp1,0);
	tmp0=tmp0.split("\n");
	tmp3=tmp0.length;
	if((tmp3|0)>1){
		tmp6=0;
		tmp5=1;
		while(1){
			tmp1=__ZN6client6TArrayIPNS_6StringEEixEd(tmp0,(+(tmp6|0)));
			tmp4=oSlot;
			console.log(tmp1[tmp4]);
			tmp6=tmp5+1|0;
			if((tmp6|0)!==(tmp3|0)){
				tmp4=tmp6;
				tmp6=tmp5;
				tmp5=tmp4;
				continue;
			}
			break;
		}
	}
	tmp1=__ZN6client6TArrayIPNS_6StringEEixEd(tmp0,(+(tmp3-1|0)));
	tmp5=oSlot;
	__ZZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE4curr=tmp1[tmp5];
	return L$plcssa|0;
}
function __ZN12_GLOBAL__N_119CheerpStringBuilder9setStringEPN6client6StringE(Larg0,Marg0,Larg1){
	Larg0[Marg0]=Larg1;
}
function __ZN12_GLOBAL__N_119CheerpStringBuilder11processCharERjS1_h(Larg0,Marg0,Larg1){
	var tmp0=0,L$psink=0,tmp2=0;
	L$psink=__ZZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE9remaining|0;
	tmp2=Larg1&255;
	a:if((Larg1&255)<192){
		if((L$psink|0)===0){
			if(Larg1<<24<=-16777216)___assert_fail(_$pstr$p5$p88,0,_$pstr$p3$p20,0,90,___func__$p_ZN12_GLOBAL__N_119CheerpStringBuilder11processCharERjS1_h,0);
			;
			__ZZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE9codepoint=tmp2;
		}else{
			if((tmp2&192|0)!==128)___assert_fail(_$pstr$p2$p19,0,_$pstr$p3$p20,0,76,___func__$p_ZN12_GLOBAL__N_119CheerpStringBuilder11processCharERjS1_h,0);
			;
			tmp2=(__ZZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE9codepoint<<6)+(tmp2&63)|0;
			__ZZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE9codepoint=tmp2;
			L$psink=L$psink-1|0;
			__ZZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE9remaining=L$psink;
			if((L$psink|0)!==0)break a;
		}
		__ZN12_GLOBAL__N_119CheerpStringBuilder15outputCodepointEj(Larg0,Marg0,tmp2);
	}else{
		if((L$psink|0)!==0)___assert_fail(_$pstr$p6$p89,0,_$pstr$p3$p20,0,101,___func__$p_ZN12_GLOBAL__N_119CheerpStringBuilder11processCharERjS1_h,0);
		;
		if((Larg1&255)<224){
			tmp0=31;
			L$psink=1;
		}else{
			tmp0=(Larg1&255)<240?15|0:7|0;
			L$psink=(Larg1&255)<240?2|0:3|0;
		}
		__ZZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE9remaining=L$psink;
		__ZZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE9codepoint=tmp0&tmp2;
	}
}
function __ZN12_GLOBAL__N_119CheerpStringBuilder9getStringEv(Larg0,Marg0){
	return Larg0[Marg0];
}
function __ZN6client6TArrayIPNS_6StringEEixEd(Larg0,Larg1){
	oSlot=0+~~Larg1|0;
	return Larg0;
}
function __ZN12_GLOBAL__N_119CheerpStringBuilder15outputCodepointEj(Larg0,Marg0,Larg1){
	var L$psink=null;
	a:{
		if(Larg1>>>0<65536){
			if((Larg1|0)===0)break a;
			L$psink=Larg0[Marg0];
			L$psink=L$psink.concat(String.fromCharCode(Larg1));
		}else{
			L$psink=Larg0[Marg0];
			L$psink=L$psink.concat(String.fromCharCode((Larg1-65536>>>10)+55296|0));
			Larg0[Marg0]=L$psink;
			L$psink=L$psink.concat(String.fromCharCode((Larg1&1023)+56320|0));
		}
		Larg0[Marg0]=L$psink;
	}
}
function _divmodti4(L$plow,L$phigh,L$plow1){
	var L$plcssa17=0,L$plcssa18=0,L$plcssa19=0,L$plcssa20=0,tmp4=0,tmp5=0,tmp6=0,tmp7=0;
	a:{
		if((L$phigh|0)!==0){
			L$plcssa20=1;
			L$plcssa19=0;
			L$plcssa18=L$plow1;
			L$plcssa17=0;
		}else{
			if(L$plow1>>>0>=L$plow>>>0){
				L$plcssa17=0;
				L$plcssa18=L$plow1;
				L$plcssa19=0;
				L$plcssa20=1;
				break a;
			}
			L$plcssa20=1;
			L$plcssa19=0;
			L$plcssa18=L$plow1;
			L$plcssa17=0;
		}
		while(1){
			L$plcssa17=(L$plcssa17<<1)+(L$plcssa18>>>31)|0;
			L$plcssa19=(L$plcssa19<<1)+(L$plcssa20>>>31)|0;
			L$plcssa20<<=1;
			L$plcssa18<<=1;
			if(L$plcssa17>>>0>=L$phigh>>>0){
				if(L$plcssa18>>>0>=L$plow>>>0)break a;
				if((L$plcssa17|0)!==(L$phigh|0))break a;
			}
			if((L$plcssa19|L$plcssa20|0)!==0)if((L$plcssa17|0)>-1)continue;
			break;
		}
	}
	if((L$plcssa19|L$plcssa20|0)===0){
		_cheerpSretSlot=0;
		return 0|0;
	}
	tmp7=L$plow;
	tmp6=L$phigh;
	tmp5=0;
	tmp4=0;
	while(1){
		a:{
			if(tmp6>>>0<=L$plcssa17>>>0){
				if(tmp7>>>0<L$plcssa18>>>0)break a;
				if((tmp6|0)!==(L$plcssa17|0))break a;
			}
			tmp6=(tmp6-L$plcssa17|0)+((tmp7>>>0<L$plcssa18>>>0?1:0)<<31>>31)|0;
			tmp4|=L$plcssa19;
			tmp5|=L$plcssa20;
			tmp7=tmp7-L$plcssa18|0;
		}
		L$plcssa20=(L$plcssa19<<31)+(L$plcssa20>>>1)|0;
		L$plcssa18=(L$plcssa17<<31)+(L$plcssa18>>>1)|0;
		L$plcssa19>>>=1;
		if((L$plcssa19|L$plcssa20|0)!==0){
			L$plcssa17>>>=1;
			continue;
		}
		break;
	}
	_cheerpSretSlot=tmp4;
	return tmp5|0;
}
function ___udivti3(L$plow,L$phigh,L$plow1){
	return (_divmodti4(L$plow,L$phigh,L$plow1)|0)|0;
}
function __start(){
	___cheerp_init_tls();
	___syscall_main_environ();
}
var __ZL8buf_size=0;
var __ZL16argv_environ_buf=new Uint8Array(65536);
var __ZGVZL8read_envPcjjE14client_environ=0;
var __ZZL8read_envPcjjE14client_environ=null;
var _main_tls$p1={a0:null,a1:nullArray,a1o:0,i2:0,i3:0,i4:0,i5:0};
var ___tlsImage=0;
var ___tlsImageSize=1048584;
var ___libc=new constructor_struct$p_Z6__libc();
var ___c_locale=[null,null,null,null,null,null];
var ___dummy_thread={a0:null,a1:null,a2:null,a3:null,i4:0,i5:0,i6:0,i7:0,i8:0,i9:0,i10:0,a11:null,i12:0,a13:null,i14:0,i15:0,a16:null,a17:null,a18:null,a19:{a0:[nullObj],i1:0,a2:null},i20:0,i21:0,a22:___c_locale[0],a23:[0],a24:null,a25:null};
var _$pstr$p1$p2=new Uint8Array([105,110,115,101,114,116,101,100,0]);
var _$pstr$p2$p3=new Uint8Array([47,104,111,109,101,47,99,105,114,99,108,101,99,105,47,112,114,111,106,101,99,116,47,99,104,101,101,114,112,111,115,47,110,101,116,119,111,114,107,47,115,116,114,101,97,109,95,100,105,114,101,99,116,46,99,112,112,0]);
var ___func__$p_ZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsE=new Uint8Array([84,67,80,83,101,114,118,101,114,83,111,99,107,101,116,0]);
var __ZN6cheerp20EscapedResourcesListIN6client13EventListenerEE9resourcesE=null;
var _$pstr$p3$p4=new Uint8Array([115,45,62,97,32,61,61,32,110,117,108,108,112,116,114,0]);
var _$pstr$p4$p5=new Uint8Array([47,104,111,109,101,47,99,105,114,99,108,101,99,105,47,112,114,111,106,101,99,116,47,99,104,101,101,114,112,111,115,47,110,101,116,119,111,114,107,47,46,46,47,99,111,114,111,47,115,117,115,112,101,110,100,101,114,46,104,0]);
var ___func__$p_ZN9SuspenderIN13StreamNetwork11AcceptQueue7PendingEE7AwaiterC2EPS3_=new Uint8Array([65,119,97,105,116,101,114,0]);
var _buf$p768=new Uint8Array(8);
var ___stderr_FILE={i0:5,a1:nullArray,a2:nullArray,a3:___stdio_close,a4:nullArray,a4o:0,a5:nullArray,a5o:0,a6:null,a7:nullArray,a7o:0,a8:null,a9:___stdio_write,a10:___stdio_seek,a11:_buf$p768,a11o:8,i12:0,a13:null,a14:null,i15:2,i16:0,i17:0,i18:0,i19:-1,i20:-1,a21:null,a22:new Int32Array(6),a23:null,a24:null,a25:null,a26:null,a27:null,a28:null};
var __ZZN12sys_internal19isBrowserMainThreadEvE16canUseAtomicWait=0;
var _cheerpSretSlot=0;
var __ZGVZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE4curr=0;
var __ZZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE4curr=null;
var __ZZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE9remaining=0;
var _$pstr$p2$p19=new Uint8Array([40,99,104,32,38,32,49,57,50,41,32,61,61,32,49,50,56,0]);
var _$pstr$p3$p20=new Uint8Array([47,98,117,105,108,100,47,99,104,101,101,114,112,45,99,111,114,101,45,118,116,55,86,106,116,47,99,104,101,101,114,112,45,99,111,114,101,45,49,55,55,49,52,48,54,52,50,51,47,99,104,101,101,114,112,45,108,105,98,115,47,115,121,115,116,101,109,47,98,114,111,119,115,101,114,46,99,112,112,0]);
var ___func__$p_ZN12_GLOBAL__N_119CheerpStringBuilder11processCharERjS1_h=new Uint8Array([112,114,111,99,101,115,115,67,104,97,114,0]);
var __ZZN12_GLOBAL__N_117do_syscall_writevEPK5ioveclE9codepoint=0;
var _$pstr$p5$p88=new Uint8Array([99,104,32,60,32,49,50,56,117,0]);
var _$pstr$p6$p89=new Uint8Array([114,101,109,97,105,110,105,110,103,32,61,61,32,48,0]);
var _aio_fd_cnt=0;
var _maplock={a0:new Int32Array(16),a1:[nullObj,nullObj,nullObj,nullObj,nullObj,nullObj,nullObj,nullObj]};
var _$pstr$p105=new Uint8Array([65,115,115,101,114,116,105,111,110,32,102,97,105,108,101,100,58,32,37,115,32,40,37,115,58,32,37,115,58,32,37,100,41,10,0]);
var _states$p805=new Uint8Array([25,0,10,0,25,25,25,0,0,0,0,5,0,0,0,0,0,0,9,0,0,0,0,11,0,0,0,0,0,0,0,0,25,0,17,10,25,25,25,3,10,7,0,1,27,9,11,24,0,0,9,6,11,0,0,11,0,6,25,0,0,0,25,25,25,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,14,0,0,0,0,0,0,0,0,25,0,10,13,25,25,25,0,13,0,0,2,0,9,14,0,0,0,9,0,14,0,0,14,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,12,0,0,0,0,0,0,0,0,0,0,0,19,0,0,0,0,19,0,0,0,0,9,12,0,0,0,0,0,12,0,0,12,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,16,0,0,0,0,0,0,0,0,0,0,0,15,0,0,0,4,15,0,0,0,0,9,16,0,0,0,0,0,16,0,0,16,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,18,0,0,0,0,0,0,0,0,0,0,0,17,0,0,0,0,17,0,0,0,0,9,18,0,0,0,0,0,18,0,0,18,0,0,26,0,0,0,26,26,26,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,26,0,0,0,26,26,26,0,0,0,0,0,0,9,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,20,0,0,0,0,0,0,0,0,0,0,0,23,0,0,0,0,23,0,0,0,0,9,20,0,0,0,0,0,20,0,0,20,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,22,0,0,0,0,0,0,0,0,0,0,0,21,0,0,0,0,21,0,0,0,0,9,22,0,0,0,0,0,22,0,0,22,0,0]);
var _$pstr$p2$p809=new Uint8Array([40,110,117,108,108,41,0]);
var _$pstr$p790=new Uint8Array([45,43,32,32,32,48,88,48,120,0]);
var _buf$p778=new Uint8Array(1032);
var ___stdout_FILE={i0:5,a1:nullArray,a2:nullArray,a3:___stdio_close,a4:nullArray,a4o:0,a5:nullArray,a5o:0,a6:null,a7:nullArray,a7o:0,a8:null,a9:___stdout_write,a10:___stdio_seek,a11:_buf$p778,a11o:8,i12:1024,a13:null,a14:null,i15:1,i16:0,i17:0,i18:0,i19:-1,i20:10,a21:null,a22:new Int32Array(6),a23:null,a24:null,a25:null,a26:null,a27:null,a28:null};
function constructor__ZN13StreamNetwork11AcceptQueue3popEv$pFrame(){
	this.a0=null;
	this.a1=null;
	this.a2={a0:null};
	this.a3=null;
	this.a4={a0:null,a1:null};
	this.a5={a0:null,a1:null};
	this.a6={a0:null,a1:null};
	this.i7=0;
	this.a8={i0:0};
	this.a9={i0:0};
	create__ZN13StreamNetwork11AcceptQueue3popEv$pFrame(this)}
function constructor__ZN16TailscaleNetwork10UDPWrapper4readEPS_PN6client31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEE$pFrame(){
	this.a0=null;
	this.a1=null;
	this.a2={a0:null};
	this.a3=null;
	this.a4=null;
	this.a5=null;
	this.a6=null;
	this.a7=null;
	this.i8=0;
	this.a9={a0:null,i1:0,a2:nullArray};
	this.i10=0;
	this.a11={i0:0};
	this.a12={i0:0};
	create__ZN16TailscaleNetwork10UDPWrapper4readEPS_PN6client31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEE$pFrame(this)}
function constructor__ZN16TailscaleNetwork10TCPWrapper4readEPN6client28ReadableByteStreamControllerE$pFrame(){
	this.a0=null;
	this.a1=null;
	this.a2={a0:null};
	this.a3=null;
	this.a4=null;
	this.a5=null;
	this.i6=0;
	this.a7={a0:null,i1:0,a2:nullArray};
	this.i8=0;
	this.a9={i0:0};
	this.a10={i0:0};
	create__ZN16TailscaleNetwork10TCPWrapper4readEPN6client28ReadableByteStreamControllerE$pFrame(this)}
function constructor__ZZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsEENKUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_clES9_$pFrame(){
	this.a0=null;
	this.a1=null;
	this.a2={a0:null};
	this.a3=null;
	this.a4=null;
	this.a5={a0:null,a1:null,a2:nullArray};
	this.i6=0;
	this.a7={i0:0};
	this.a8={i0:0};
	create__ZZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsEENKUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_clES9_$pFrame(this)}
function constructor__ZN16TailscaleNetwork10TCPWrapper6acceptEPS_PN6client31ReadableStreamDefaultControllerIPNS2_6ObjectEEEi$pFrame(){
	this.a0=null;
	this.a1=null;
	this.a2={a0:null};
	this.a3=null;
	this.a4=null;
	this.a5=null;
	this.i6=0;
	this.i7=0;
	this.a8={a0:null,i1:0,a2:nullArray};
	this.i9=0;
	this.a10={i0:0};
	this.a11={i0:0};
	create__ZN16TailscaleNetwork10TCPWrapper6acceptEPS_PN6client31ReadableStreamDefaultControllerIPNS2_6ObjectEEEi$pFrame(this)}
function constructor_struct$p_Z8_IO_FILE(){
	this.i0=0;
	this.a1=nullArray;
	this.a2=nullArray;
	this.a3=null;
	this.a4=nullArray;
	this.a4o=0;
	this.a5=nullArray;
	this.a5o=0;
	this.a6=null;
	this.a7=nullArray;
	this.a7o=0;
	this.a8=null;
	this.a9=null;
	this.a10=null;
	this.a11=nullArray;
	this.a11o=0;
	this.i12=0;
	this.a13=null;
	this.a14=null;
	this.i15=0;
	this.i16=0;
	this.i17=0;
	this.i18=0;
	this.i19=0;
	this.i20=0;
	this.a21=null;
	this.a22=new Int32Array(6);
	this.a23=null;
	this.a24=null;
	this.a25=null;
	this.a26=null;
	this.a27=null;
	this.a28=null;
}
function constructor__ZN16TailscaleNetwork10TCPWrapper5writeEPN6client10Uint8ArrayEPNS1_31WritableStreamDefaultControllerE$pFrame(){
	this.a0=null;
	this.a1=null;
	this.a2={a0:null};
	this.a3=null;
	this.a4=null;
	this.a5=null;
	this.i6=0;
	this.i7=0;
	this.i8=0;
	this.a9={a0:null,i1:0,a2:nullArray};
	this.i10=0;
	this.a11={i0:0};
	this.a12={i0:0};
	create__ZN16TailscaleNetwork10TCPWrapper5writeEPN6client10Uint8ArrayEPNS1_31WritableStreamDefaultControllerE$pFrame(this)}
function constructor__ZN16TailscaleNetwork2upEv$pFrame(){
	this.a0=null;
	this.a1=null;
	this.a2={a0:null};
	this.a3=null;
	this.a4=null;
	this.a5={a0:null,a1:null,a2:nullArray};
	this.a6={a0:null,a1:null,a2:nullArray};
	this.a7={a0:null,a1:null,a2:nullArray};
	this.i8=0;
	this.a9={i0:0};
	this.a10={i0:0};
	create__ZN16TailscaleNetwork2upEv$pFrame(this)}
function constructor_struct$p_Z6__libc(){
	this.i0=0;
	this.i1=0;
	this.a2=null;
	this.a3=null;
	this.i4=0;
	this.i5=0;
	this.i6=0;
	this.i7=0;
	this.a8=[null,null,null,null,null,null];
}
function constructor__ZZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEENKUlvE_clEv$pFrame(){
	this.a0=null;
	this.a1=null;
	this.a2={a0:null};
	this.a3=null;
	this.a4={a0:null,a1:null,a2:nullArray};
	this.a5={a0:null,a1:null,a2:nullArray};
	this.i6=0;
	this.a7={i0:0};
	this.a8={i0:0};
	create__ZZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEENKUlvE_clEv$pFrame(this)}
function constructor_struct$p_Z9__pthread(){
	this.a0=null;
	this.a1=null;
	this.a2=null;
	this.a3=null;
	this.i4=0;
	this.i5=0;
	this.i6=0;
	this.i7=0;
	this.i8=0;
	this.i9=0;
	this.i10=0;
	this.a11=null;
	this.i12=0;
	this.a13=null;
	this.i14=0;
	this.i15=0;
	this.a16=null;
	this.a17=null;
	this.a18=null;
	this.a19={a0:[nullObj],i1:0,a2:null};
	this.i20=0;
	this.i21=0;
	this.a22=null;
	this.a23=[0];
	this.a24=null;
	this.a25=null;
}
function constructor__ZZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEENKUlvE_clEv$pFrame(){
	this.a0=null;
	this.a1=null;
	this.a2={a0:null};
	this.a3=null;
	this.a4={a0:null,a1:null,a2:nullArray};
	this.a5={a0:null,a1:null,a2:nullArray};
	this.i6=0;
	this.a7={i0:0};
	this.a8={i0:0};
	create__ZZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEENKUlvE_clEv$pFrame(this)}
function constructor__ZN16TailscaleNetwork10TCPWrapper7connectEPS_PN6client6StringEj$pFrame(){
	this.a0=null;
	this.a1=null;
	this.a2={i0:0};
	this.a3={a0:null,i1:0,a2:nullArray};
	this.i4=0;
	this.a5={i0:0};
	this.a6={i0:0};
	this.a7=null;
	this.a8=null;
	this.a9=null;
	this.i10=0;
	this.i11=0;
	create__ZN16TailscaleNetwork10TCPWrapper7connectEPS_PN6client6StringEj$pFrame(this)}
function create__ZN13StreamNetwork11AcceptQueue3popEv$pFrame(obj){
	var a=[];
	a[0]=obj;
	obj.o=0;
	obj.a=a;
	a[1]=obj.a2;
	obj.a2.o=1;
	obj.a2.a=a;
	return obj;}
function create__ZN16TailscaleNetwork10TCPWrapper4readEPN6client28ReadableByteStreamControllerE$pFrame(obj){
	var a=[];
	a[0]=obj;
	obj.o=0;
	obj.a=a;
	a[1]=obj.a2;
	obj.a2.o=1;
	obj.a2.a=a;
	return obj;}
function create__ZN16TailscaleNetwork10TCPWrapper5writeEPN6client10Uint8ArrayEPNS1_31WritableStreamDefaultControllerE$pFrame(obj){
	var a=[];
	a[0]=obj;
	obj.o=0;
	obj.a=a;
	a[1]=obj.a2;
	obj.a2.o=1;
	obj.a2.a=a;
	return obj;}
function create__ZN16TailscaleNetwork10UDPWrapper4readEPS_PN6client31ReadableStreamDefaultControllerIPNS2_10UDPMessageEEE$pFrame(obj){
	var a=[];
	a[0]=obj;
	obj.o=0;
	obj.a=a;
	a[1]=obj.a2;
	obj.a2.o=1;
	obj.a2.a=a;
	return obj;}
function create__ZZN16TailscaleNetwork10UDPWrapperC1EPN6client11IPUDPSocketEENKUlvE_clEv$pFrame(obj){
	var a=[];
	a[0]=obj;
	obj.o=0;
	obj.a=a;
	a[1]=obj.a2;
	obj.a2.o=1;
	obj.a2.a=a;
	return obj;}
function create__ZZN13StreamNetwork9TCPServerC1EPN6client14ReadableStreamIPNS1_6ObjectEEEENKUlvE_clEv$pFrame(obj){
	var a=[];
	a[0]=obj;
	obj.o=0;
	obj.a=a;
	a[1]=obj.a2;
	obj.a2.o=1;
	obj.a2.a=a;
	return obj;}
function create__ZZN13StreamNetwork9TCPClientC1EPN6client14ReadableStreamIPNS1_10Uint8ArrayEEEPNS1_14WritableStreamIS4_EEPNS1_20PromiseWithResolversIPNS1_4_AnyEEESE_ENKUlvE_clEv$pFrame(obj){
	var a=[];
	a[0]=obj;
	obj.o=0;
	obj.a=a;
	a[1]=obj.a2;
	obj.a2.o=1;
	obj.a2.a=a;
	return obj;}
function create__ZN16TailscaleNetwork2upEv$pFrame(obj){
	var a=[];
	a[0]=obj;
	obj.o=0;
	obj.a=a;
	a[1]=obj.a2;
	obj.a2.o=1;
	obj.a2.a=a;
	return obj;}
function create__ZZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsEENKUlPNS0_31ReadableStreamDefaultControllerIPNS0_6ObjectEEEE_clES9_$pFrame(obj){
	var a=[];
	a[0]=obj;
	obj.o=0;
	obj.a=a;
	a[1]=obj.a2;
	obj.a2.o=1;
	obj.a2.a=a;
	return obj;}
function create__ZN16TailscaleNetwork10TCPWrapper6acceptEPS_PN6client31ReadableStreamDefaultControllerIPNS2_6ObjectEEEi$pFrame(obj){
	var a=[];
	a[0]=obj;
	obj.o=0;
	obj.a=a;
	a[1]=obj.a2;
	obj.a2.o=1;
	obj.a2.a=a;
	return obj;}
function create__ZN16TailscaleNetwork10TCPWrapper7connectEPS_PN6client6StringEj$pFrame(obj){
	var a=[];
	a[0]=obj;
	obj.o=0;
	obj.a=a;
	a[1]=obj.a2;
	obj.a2.o=1;
	obj.a2.a=a;
	return obj;}
function create__ZZN16TailscaleNetwork10TCPWrapperC1EPN6client11IPTCPSocketEENKUlvE_clEv$pFrame(obj){
	var a=[];
	a[0]=obj;
	obj.o=0;
	obj.a=a;
	a[1]=obj.a2;
	obj.a2.o=1;
	obj.a2.a=a;
	return obj;}
function createArray_struct$p_ZN13StreamNetwork11AcceptQueue7PendingE(e){
	var r=[];
	for(var i=0;i<e;i++)
	r[i]={a0:null,a1:null};
	return r;
}
function createArray_struct$p_Z3arg(e){
	var r=[];
	for(var i=0;i<e;i++)
	r[i]={a0:new Int32Array(2),d1:-0.,a2:nullArray,a2o:0};
	return r;
}
function createPointerArray(r,s,e,v){for(var i=s;i<e;i++)r[i]=v;return r;}
function cheerpCreateClosure(func, obj){return function(){var a=Array.prototype.slice.call(arguments);a.unshift(obj);return func.apply(null,a);};}
function cheerpCreateClosureSplit(func, obj, objo){return function(){var a=Array.prototype.slice.call(arguments);a.unshift(obj,objo);return func.apply(null,a);};}
function handleVAArg(ptr){var ret=ptr.d[ptr.o];ptr.o++;return ret;}
function CheerpException(m,e,c){
	var t=e?'':'Uncaught C++ exception: ';
	var instance=new Error(t+m);
	instance.name='CheerpException';
	instance.isExit=e;
	instance.code=c;
	Object.setPrototypeOf(instance,Object.getPrototypeOf(this));
	if(Error.captureStackTrace){
		Error.captureStackTrace(instance, CheerpException);
	}
	return instance;
}
CheerpException.prototype=Object.create(Error.prototype);
var DirectSocketsNetwork={};
var DummyNetwork={};
var StreamNetwork={};
var TailscaleNetwork={};
export default function(tmp0){
	CHEERP_ENV=(typeof tmp0 == 'undefined' ? null : tmp0.env) || null;
	CHEERP_ARGV=(typeof tmp0 == 'undefined' ? null : tmp0.argv) || null;
	return Promise.resolve().then(_=>{
		DirectSocketsNetwork=function (){
			this.this=__ZN20DirectSocketsNetwork3newEv();
		};
		DirectSocketsNetwork.prototype.TCPServerSocket=function(a0,a1){
			return __ZN20DirectSocketsNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsE(this.this,a0,a1);
		};
		DirectSocketsNetwork.prototype.TCPSocket=function(a0,a1){
			return __ZN20DirectSocketsNetwork9TCPSocketEPN6client6StringEj(this.this,a0,a1);
		};
		DirectSocketsNetwork.prototype.UDPSocket=function(a0){
			return __ZN20DirectSocketsNetwork9UDPSocketEPN6client16UDPSocketOptionsE(this.this,a0);
		};
		DirectSocketsNetwork.prototype.delete=function(){
			return __ZN20DirectSocketsNetwork6deleteEv(this.this);
		};
		DirectSocketsNetwork.prototype.up=function(){
			return __ZN20DirectSocketsNetwork2upEv(this.this);
		};
		DummyNetwork=function (){
			this.this=__ZN12DummyNetwork3newEv();
		};
		DummyNetwork.prototype.TCPServerSocket=function(a0,a1){
			return __ZN12DummyNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsE(this.this,a0,a1);
		};
		DummyNetwork.prototype.TCPSocket=function(a0,a1){
			return __ZN12DummyNetwork9TCPSocketEPN6client6StringEj(this.this,a0,a1);
		};
		DummyNetwork.prototype.UDPSocket=function(a0){
			return __ZN12DummyNetwork9UDPSocketEPN6client16UDPSocketOptionsE(this.this,a0);
		};
		DummyNetwork.prototype.delete=function(){
			return __ZN12DummyNetwork6deleteEv(this.this);
		};
		DummyNetwork.prototype.up=function(){
			return __ZN12DummyNetwork2upEv(this.this);
		};
		StreamNetwork=function (a0){
			this.this=__ZN13StreamNetwork3newEPN6client6ObjectE(a0);
		};
		StreamNetwork.prototype.TCPServerSocket=function(a0,a1){
			return __ZN13StreamNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsE(this.this,a0,a1);
		};
		StreamNetwork.prototype.TCPSocket=function(a0,a1){
			return __ZN13StreamNetwork9TCPSocketEPN6client6StringEj(this.this,a0,a1);
		};
		StreamNetwork.prototype.UDPSocket=function(a0){
			return __ZN13StreamNetwork9UDPSocketEPN6client16UDPSocketOptionsE(this.this,a0);
		};
		StreamNetwork.prototype.delete=function(){
			return __ZN13StreamNetwork6deleteEv(this.this);
		};
		StreamNetwork.prototype.up=function(){
			return __ZN13StreamNetwork2upEv(this.this);
		};
		TailscaleNetwork=function (a0){
			this.this=__ZN16TailscaleNetwork3newEPN6client6ObjectE(a0);
		};
		TailscaleNetwork.prototype.TCPServerSocket=function(a0,a1){
			return __ZN16TailscaleNetwork15TCPServerSocketEPN6client6StringEPNS0_22TCPServerSocketOptionsE(this.this,a0,a1);
		};
		TailscaleNetwork.prototype.TCPSocket=function(a0,a1){
			return __ZN16TailscaleNetwork9TCPSocketEPN6client6StringEj(this.this,a0,a1);
		};
		TailscaleNetwork.prototype.UDPSocket=function(a0){
			return __ZN16TailscaleNetwork9UDPSocketEPN6client16UDPSocketOptionsE(this.this,a0);
		};
		TailscaleNetwork.prototype.delete=function(){
			return __ZN16TailscaleNetwork6deleteEv(this.this);
		};
		TailscaleNetwork.prototype.up=function(){
			return __ZN16TailscaleNetwork2upEv(this.this);
		};
		try{
			__start();
		}catch(e){
			if(!(e instanceof CheerpException&&e.isExit&&e.code==0))throw(e);
		}
		var __export={
			DirectSocketsNetwork:DirectSocketsNetwork,
			DummyNetwork:DummyNetwork,
			StreamNetwork:StreamNetwork,
			TailscaleNetwork:TailscaleNetwork,
		};
		return __export;
	});
}
