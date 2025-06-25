'use strict';

customElements.define('compodoc-menu', class extends HTMLElement {
    constructor() {
        super();
        this.isNormalMode = this.getAttribute('mode') === 'normal';
    }

    connectedCallback() {
        this.render(this.isNormalMode);
    }

    render(isNormalMode) {
        let tp = lithtml.html(`
        <nav>
            <ul class="list">
                <li class="title">
                    <a href="index.html" data-type="index-link">project-name documentation</a>
                </li>

                <li class="divider"></li>
                ${ isNormalMode ? `<div id="book-search-input" role="search"><input type="text" placeholder="Type to search"></div>` : '' }
                <li class="chapter">
                    <a data-type="chapter-link" href="index.html"><span class="icon ion-ios-home"></span>Getting started</a>
                    <ul class="links">
                        <li class="link">
                            <a href="overview.html" data-type="chapter-link">
                                <span class="icon ion-ios-keypad"></span>Overview
                            </a>
                        </li>
                        <li class="link">
                            <a href="index.html" data-type="chapter-link">
                                <span class="icon ion-ios-paper"></span>README
                            </a>
                        </li>
                                <li class="link">
                                    <a href="dependencies.html" data-type="chapter-link">
                                        <span class="icon ion-ios-list"></span>Dependencies
                                    </a>
                                </li>
                                <li class="link">
                                    <a href="properties.html" data-type="chapter-link">
                                        <span class="icon ion-ios-apps"></span>Properties
                                    </a>
                                </li>
                    </ul>
                </li>
                    <li class="chapter modules">
                        <a data-type="chapter-link" href="modules.html">
                            <div class="menu-toggler linked" data-bs-toggle="collapse" ${ isNormalMode ?
                                'data-bs-target="#modules-links"' : 'data-bs-target="#xs-modules-links"' }>
                                <span class="icon ion-ios-archive"></span>
                                <span class="link-name">Modules</span>
                                <span class="icon ion-ios-arrow-down"></span>
                            </div>
                        </a>
                        <ul class="links collapse " ${ isNormalMode ? 'id="modules-links"' : 'id="xs-modules-links"' }>
                            <li class="link">
                                <a href="modules/AcquireModule.html" data-type="entity-link" >AcquireModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-AcquireModule-bdabef240b0c7d44831c9d91a9202358de8292a0ac3f11438c0668dfbc5f42cd84a5dc6b844dc49eab80e1fd51025faa04963121efca0b4c0e00c406e1a239b6"' : 'data-bs-target="#xs-controllers-links-module-AcquireModule-bdabef240b0c7d44831c9d91a9202358de8292a0ac3f11438c0668dfbc5f42cd84a5dc6b844dc49eab80e1fd51025faa04963121efca0b4c0e00c406e1a239b6"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-AcquireModule-bdabef240b0c7d44831c9d91a9202358de8292a0ac3f11438c0668dfbc5f42cd84a5dc6b844dc49eab80e1fd51025faa04963121efca0b4c0e00c406e1a239b6"' :
                                            'id="xs-controllers-links-module-AcquireModule-bdabef240b0c7d44831c9d91a9202358de8292a0ac3f11438c0668dfbc5f42cd84a5dc6b844dc49eab80e1fd51025faa04963121efca0b4c0e00c406e1a239b6"' }>
                                            <li class="link">
                                                <a href="controllers/AcquireController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >AcquireController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-AcquireModule-bdabef240b0c7d44831c9d91a9202358de8292a0ac3f11438c0668dfbc5f42cd84a5dc6b844dc49eab80e1fd51025faa04963121efca0b4c0e00c406e1a239b6"' : 'data-bs-target="#xs-injectables-links-module-AcquireModule-bdabef240b0c7d44831c9d91a9202358de8292a0ac3f11438c0668dfbc5f42cd84a5dc6b844dc49eab80e1fd51025faa04963121efca0b4c0e00c406e1a239b6"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-AcquireModule-bdabef240b0c7d44831c9d91a9202358de8292a0ac3f11438c0668dfbc5f42cd84a5dc6b844dc49eab80e1fd51025faa04963121efca0b4c0e00c406e1a239b6"' :
                                        'id="xs-injectables-links-module-AcquireModule-bdabef240b0c7d44831c9d91a9202358de8292a0ac3f11438c0668dfbc5f42cd84a5dc6b844dc49eab80e1fd51025faa04963121efca0b4c0e00c406e1a239b6"' }>
                                        <li class="link">
                                            <a href="injectables/AcquireService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >AcquireService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/AppModule.html" data-type="entity-link" >AppModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-AppModule-ef622cf6b1decfb5ad799713110932d736c64251bdc28edaf23b5820a52eb1de2dd826a3350fc7c5eb5cbe593d5b2107a8010f7edeee1b7a82b7a6388ed70cf7"' : 'data-bs-target="#xs-controllers-links-module-AppModule-ef622cf6b1decfb5ad799713110932d736c64251bdc28edaf23b5820a52eb1de2dd826a3350fc7c5eb5cbe593d5b2107a8010f7edeee1b7a82b7a6388ed70cf7"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-AppModule-ef622cf6b1decfb5ad799713110932d736c64251bdc28edaf23b5820a52eb1de2dd826a3350fc7c5eb5cbe593d5b2107a8010f7edeee1b7a82b7a6388ed70cf7"' :
                                            'id="xs-controllers-links-module-AppModule-ef622cf6b1decfb5ad799713110932d736c64251bdc28edaf23b5820a52eb1de2dd826a3350fc7c5eb5cbe593d5b2107a8010f7edeee1b7a82b7a6388ed70cf7"' }>
                                            <li class="link">
                                                <a href="controllers/AppController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >AppController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-AppModule-ef622cf6b1decfb5ad799713110932d736c64251bdc28edaf23b5820a52eb1de2dd826a3350fc7c5eb5cbe593d5b2107a8010f7edeee1b7a82b7a6388ed70cf7"' : 'data-bs-target="#xs-injectables-links-module-AppModule-ef622cf6b1decfb5ad799713110932d736c64251bdc28edaf23b5820a52eb1de2dd826a3350fc7c5eb5cbe593d5b2107a8010f7edeee1b7a82b7a6388ed70cf7"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-AppModule-ef622cf6b1decfb5ad799713110932d736c64251bdc28edaf23b5820a52eb1de2dd826a3350fc7c5eb5cbe593d5b2107a8010f7edeee1b7a82b7a6388ed70cf7"' :
                                        'id="xs-injectables-links-module-AppModule-ef622cf6b1decfb5ad799713110932d736c64251bdc28edaf23b5820a52eb1de2dd826a3350fc7c5eb5cbe593d5b2107a8010f7edeee1b7a82b7a6388ed70cf7"' }>
                                        <li class="link">
                                            <a href="injectables/AppService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >AppService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/AssetsModule.html" data-type="entity-link" >AssetsModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-AssetsModule-8b6c16df3ed7ac16b7c7ac3ae4ff26f43140fc1d349f770a4a916cc1f37fd4d35e0f3f1b2519f796e0e05612c57938332fedc669bce8f1afab13f90f2e1d12a1"' : 'data-bs-target="#xs-controllers-links-module-AssetsModule-8b6c16df3ed7ac16b7c7ac3ae4ff26f43140fc1d349f770a4a916cc1f37fd4d35e0f3f1b2519f796e0e05612c57938332fedc669bce8f1afab13f90f2e1d12a1"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-AssetsModule-8b6c16df3ed7ac16b7c7ac3ae4ff26f43140fc1d349f770a4a916cc1f37fd4d35e0f3f1b2519f796e0e05612c57938332fedc669bce8f1afab13f90f2e1d12a1"' :
                                            'id="xs-controllers-links-module-AssetsModule-8b6c16df3ed7ac16b7c7ac3ae4ff26f43140fc1d349f770a4a916cc1f37fd4d35e0f3f1b2519f796e0e05612c57938332fedc669bce8f1afab13f90f2e1d12a1"' }>
                                            <li class="link">
                                                <a href="controllers/AssetsController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >AssetsController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-AssetsModule-8b6c16df3ed7ac16b7c7ac3ae4ff26f43140fc1d349f770a4a916cc1f37fd4d35e0f3f1b2519f796e0e05612c57938332fedc669bce8f1afab13f90f2e1d12a1"' : 'data-bs-target="#xs-injectables-links-module-AssetsModule-8b6c16df3ed7ac16b7c7ac3ae4ff26f43140fc1d349f770a4a916cc1f37fd4d35e0f3f1b2519f796e0e05612c57938332fedc669bce8f1afab13f90f2e1d12a1"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-AssetsModule-8b6c16df3ed7ac16b7c7ac3ae4ff26f43140fc1d349f770a4a916cc1f37fd4d35e0f3f1b2519f796e0e05612c57938332fedc669bce8f1afab13f90f2e1d12a1"' :
                                        'id="xs-injectables-links-module-AssetsModule-8b6c16df3ed7ac16b7c7ac3ae4ff26f43140fc1d349f770a4a916cc1f37fd4d35e0f3f1b2519f796e0e05612c57938332fedc669bce8f1afab13f90f2e1d12a1"' }>
                                        <li class="link">
                                            <a href="injectables/AssetsService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >AssetsService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/AuthModule.html" data-type="entity-link" >AuthModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-AuthModule-0e4807bd838d7a6c8c909aa2330e3294ac705982bc0db29aca0f4fde7da00551110b766fe0f0d914fc69c4a1ab814ebc4ba5c3c77160009eba192f8f987246e6"' : 'data-bs-target="#xs-controllers-links-module-AuthModule-0e4807bd838d7a6c8c909aa2330e3294ac705982bc0db29aca0f4fde7da00551110b766fe0f0d914fc69c4a1ab814ebc4ba5c3c77160009eba192f8f987246e6"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-AuthModule-0e4807bd838d7a6c8c909aa2330e3294ac705982bc0db29aca0f4fde7da00551110b766fe0f0d914fc69c4a1ab814ebc4ba5c3c77160009eba192f8f987246e6"' :
                                            'id="xs-controllers-links-module-AuthModule-0e4807bd838d7a6c8c909aa2330e3294ac705982bc0db29aca0f4fde7da00551110b766fe0f0d914fc69c4a1ab814ebc4ba5c3c77160009eba192f8f987246e6"' }>
                                            <li class="link">
                                                <a href="controllers/AuthController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >AuthController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-AuthModule-0e4807bd838d7a6c8c909aa2330e3294ac705982bc0db29aca0f4fde7da00551110b766fe0f0d914fc69c4a1ab814ebc4ba5c3c77160009eba192f8f987246e6"' : 'data-bs-target="#xs-injectables-links-module-AuthModule-0e4807bd838d7a6c8c909aa2330e3294ac705982bc0db29aca0f4fde7da00551110b766fe0f0d914fc69c4a1ab814ebc4ba5c3c77160009eba192f8f987246e6"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-AuthModule-0e4807bd838d7a6c8c909aa2330e3294ac705982bc0db29aca0f4fde7da00551110b766fe0f0d914fc69c4a1ab814ebc4ba5c3c77160009eba192f8f987246e6"' :
                                        'id="xs-injectables-links-module-AuthModule-0e4807bd838d7a6c8c909aa2330e3294ac705982bc0db29aca0f4fde7da00551110b766fe0f0d914fc69c4a1ab814ebc4ba5c3c77160009eba192f8f987246e6"' }>
                                        <li class="link">
                                            <a href="injectables/AuthService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >AuthService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/AwsModule.html" data-type="entity-link" >AwsModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-AwsModule-d670b4ba105bb856a1cb7fbbcad79953158884fe56e4df7db806d001946505a15b5c1ec1732b62159155d5f20dabdc30f4f1df712b390c45302d0e8359e351e9"' : 'data-bs-target="#xs-controllers-links-module-AwsModule-d670b4ba105bb856a1cb7fbbcad79953158884fe56e4df7db806d001946505a15b5c1ec1732b62159155d5f20dabdc30f4f1df712b390c45302d0e8359e351e9"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-AwsModule-d670b4ba105bb856a1cb7fbbcad79953158884fe56e4df7db806d001946505a15b5c1ec1732b62159155d5f20dabdc30f4f1df712b390c45302d0e8359e351e9"' :
                                            'id="xs-controllers-links-module-AwsModule-d670b4ba105bb856a1cb7fbbcad79953158884fe56e4df7db806d001946505a15b5c1ec1732b62159155d5f20dabdc30f4f1df712b390c45302d0e8359e351e9"' }>
                                            <li class="link">
                                                <a href="controllers/AwsController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >AwsController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-AwsModule-d670b4ba105bb856a1cb7fbbcad79953158884fe56e4df7db806d001946505a15b5c1ec1732b62159155d5f20dabdc30f4f1df712b390c45302d0e8359e351e9"' : 'data-bs-target="#xs-injectables-links-module-AwsModule-d670b4ba105bb856a1cb7fbbcad79953158884fe56e4df7db806d001946505a15b5c1ec1732b62159155d5f20dabdc30f4f1df712b390c45302d0e8359e351e9"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-AwsModule-d670b4ba105bb856a1cb7fbbcad79953158884fe56e4df7db806d001946505a15b5c1ec1732b62159155d5f20dabdc30f4f1df712b390c45302d0e8359e351e9"' :
                                        'id="xs-injectables-links-module-AwsModule-d670b4ba105bb856a1cb7fbbcad79953158884fe56e4df7db806d001946505a15b5c1ec1732b62159155d5f20dabdc30f4f1df712b390c45302d0e8359e351e9"' }>
                                        <li class="link">
                                            <a href="injectables/AwsService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >AwsService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/BlockchainModule.html" data-type="entity-link" >BlockchainModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-BlockchainModule-16eccec0a6fb2a02b137d77ac270aa6c6289afb70a287b4453cd408025df1c3b721d8ed693cf76811d63bf70f77323c89ecfa392c445af95f6a544984787e253"' : 'data-bs-target="#xs-controllers-links-module-BlockchainModule-16eccec0a6fb2a02b137d77ac270aa6c6289afb70a287b4453cd408025df1c3b721d8ed693cf76811d63bf70f77323c89ecfa392c445af95f6a544984787e253"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-BlockchainModule-16eccec0a6fb2a02b137d77ac270aa6c6289afb70a287b4453cd408025df1c3b721d8ed693cf76811d63bf70f77323c89ecfa392c445af95f6a544984787e253"' :
                                            'id="xs-controllers-links-module-BlockchainModule-16eccec0a6fb2a02b137d77ac270aa6c6289afb70a287b4453cd408025df1c3b721d8ed693cf76811d63bf70f77323c89ecfa392c445af95f6a544984787e253"' }>
                                            <li class="link">
                                                <a href="controllers/BlockchainController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >BlockchainController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-BlockchainModule-16eccec0a6fb2a02b137d77ac270aa6c6289afb70a287b4453cd408025df1c3b721d8ed693cf76811d63bf70f77323c89ecfa392c445af95f6a544984787e253"' : 'data-bs-target="#xs-injectables-links-module-BlockchainModule-16eccec0a6fb2a02b137d77ac270aa6c6289afb70a287b4453cd408025df1c3b721d8ed693cf76811d63bf70f77323c89ecfa392c445af95f6a544984787e253"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-BlockchainModule-16eccec0a6fb2a02b137d77ac270aa6c6289afb70a287b4453cd408025df1c3b721d8ed693cf76811d63bf70f77323c89ecfa392c445af95f6a544984787e253"' :
                                        'id="xs-injectables-links-module-BlockchainModule-16eccec0a6fb2a02b137d77ac270aa6c6289afb70a287b4453cd408025df1c3b721d8ed693cf76811d63bf70f77323c89ecfa392c445af95f6a544984787e253"' }>
                                        <li class="link">
                                            <a href="injectables/AnvilApiService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >AnvilApiService</a>
                                        </li>
                                        <li class="link">
                                            <a href="injectables/BlockchainScannerService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >BlockchainScannerService</a>
                                        </li>
                                        <li class="link">
                                            <a href="injectables/BlockchainService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >BlockchainService</a>
                                        </li>
                                        <li class="link">
                                            <a href="injectables/VaultInsertingService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >VaultInsertingService</a>
                                        </li>
                                        <li class="link">
                                            <a href="injectables/VaultManagingService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >VaultManagingService</a>
                                        </li>
                                        <li class="link">
                                            <a href="injectables/WebhookVerificationService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >WebhookVerificationService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/ContributionModule.html" data-type="entity-link" >ContributionModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-ContributionModule-9a35ca619e3532df2481c2789ead80a544a8c29314c15f73ad707fc1d862d28b6ec5461b5bccf394d1db86d7b69c5c8d87dd7a8c91ccc06fb93b59d4437411c6"' : 'data-bs-target="#xs-controllers-links-module-ContributionModule-9a35ca619e3532df2481c2789ead80a544a8c29314c15f73ad707fc1d862d28b6ec5461b5bccf394d1db86d7b69c5c8d87dd7a8c91ccc06fb93b59d4437411c6"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-ContributionModule-9a35ca619e3532df2481c2789ead80a544a8c29314c15f73ad707fc1d862d28b6ec5461b5bccf394d1db86d7b69c5c8d87dd7a8c91ccc06fb93b59d4437411c6"' :
                                            'id="xs-controllers-links-module-ContributionModule-9a35ca619e3532df2481c2789ead80a544a8c29314c15f73ad707fc1d862d28b6ec5461b5bccf394d1db86d7b69c5c8d87dd7a8c91ccc06fb93b59d4437411c6"' }>
                                            <li class="link">
                                                <a href="controllers/ContributionController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >ContributionController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-ContributionModule-9a35ca619e3532df2481c2789ead80a544a8c29314c15f73ad707fc1d862d28b6ec5461b5bccf394d1db86d7b69c5c8d87dd7a8c91ccc06fb93b59d4437411c6"' : 'data-bs-target="#xs-injectables-links-module-ContributionModule-9a35ca619e3532df2481c2789ead80a544a8c29314c15f73ad707fc1d862d28b6ec5461b5bccf394d1db86d7b69c5c8d87dd7a8c91ccc06fb93b59d4437411c6"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-ContributionModule-9a35ca619e3532df2481c2789ead80a544a8c29314c15f73ad707fc1d862d28b6ec5461b5bccf394d1db86d7b69c5c8d87dd7a8c91ccc06fb93b59d4437411c6"' :
                                        'id="xs-injectables-links-module-ContributionModule-9a35ca619e3532df2481c2789ead80a544a8c29314c15f73ad707fc1d862d28b6ec5461b5bccf394d1db86d7b69c5c8d87dd7a8c91ccc06fb93b59d4437411c6"' }>
                                        <li class="link">
                                            <a href="injectables/ContributionService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >ContributionService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/DistributionModule.html" data-type="entity-link" >DistributionModule</a>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-DistributionModule-f160dc7b1849fca470ba472b5b7ad59d01cacdbfcb759f35acaff8c90b2639f9dd0ba407f2517fbe7cbe952eff2e75d0217f438403c9e3c93eb9cb4799c300e4"' : 'data-bs-target="#xs-injectables-links-module-DistributionModule-f160dc7b1849fca470ba472b5b7ad59d01cacdbfcb759f35acaff8c90b2639f9dd0ba407f2517fbe7cbe952eff2e75d0217f438403c9e3c93eb9cb4799c300e4"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-DistributionModule-f160dc7b1849fca470ba472b5b7ad59d01cacdbfcb759f35acaff8c90b2639f9dd0ba407f2517fbe7cbe952eff2e75d0217f438403c9e3c93eb9cb4799c300e4"' :
                                        'id="xs-injectables-links-module-DistributionModule-f160dc7b1849fca470ba472b5b7ad59d01cacdbfcb759f35acaff8c90b2639f9dd0ba407f2517fbe7cbe952eff2e75d0217f438403c9e3c93eb9cb4799c300e4"' }>
                                        <li class="link">
                                            <a href="injectables/DistributionService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >DistributionService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/GovernanceModule.html" data-type="entity-link" >GovernanceModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-GovernanceModule-d385d419fc19839fd9cfa6fe79ed6711d46deba97c4af15ddd40bcb00faa72bfc069919337ab11bae0f102352d1a5a8bf03a226b05963ce5032ef15450c0bb2e"' : 'data-bs-target="#xs-controllers-links-module-GovernanceModule-d385d419fc19839fd9cfa6fe79ed6711d46deba97c4af15ddd40bcb00faa72bfc069919337ab11bae0f102352d1a5a8bf03a226b05963ce5032ef15450c0bb2e"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-GovernanceModule-d385d419fc19839fd9cfa6fe79ed6711d46deba97c4af15ddd40bcb00faa72bfc069919337ab11bae0f102352d1a5a8bf03a226b05963ce5032ef15450c0bb2e"' :
                                            'id="xs-controllers-links-module-GovernanceModule-d385d419fc19839fd9cfa6fe79ed6711d46deba97c4af15ddd40bcb00faa72bfc069919337ab11bae0f102352d1a5a8bf03a226b05963ce5032ef15450c0bb2e"' }>
                                            <li class="link">
                                                <a href="controllers/GovernanceController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >GovernanceController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-GovernanceModule-d385d419fc19839fd9cfa6fe79ed6711d46deba97c4af15ddd40bcb00faa72bfc069919337ab11bae0f102352d1a5a8bf03a226b05963ce5032ef15450c0bb2e"' : 'data-bs-target="#xs-injectables-links-module-GovernanceModule-d385d419fc19839fd9cfa6fe79ed6711d46deba97c4af15ddd40bcb00faa72bfc069919337ab11bae0f102352d1a5a8bf03a226b05963ce5032ef15450c0bb2e"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-GovernanceModule-d385d419fc19839fd9cfa6fe79ed6711d46deba97c4af15ddd40bcb00faa72bfc069919337ab11bae0f102352d1a5a8bf03a226b05963ce5032ef15450c0bb2e"' :
                                        'id="xs-injectables-links-module-GovernanceModule-d385d419fc19839fd9cfa6fe79ed6711d46deba97c4af15ddd40bcb00faa72bfc069919337ab11bae0f102352d1a5a8bf03a226b05963ce5032ef15450c0bb2e"' }>
                                        <li class="link">
                                            <a href="injectables/GovernanceService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >GovernanceService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/JwtGlobalModule.html" data-type="entity-link" >JwtGlobalModule</a>
                            </li>
                            <li class="link">
                                <a href="modules/LifecycleModule.html" data-type="entity-link" >LifecycleModule</a>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-LifecycleModule-473a63e41d6fffd7c1909f6491334e14a88cba344ad915d67748a96fc9bb2e2b841f8586f1ff08140f22db09df3ad7155c49f4c482bc807abd8692f157c55442"' : 'data-bs-target="#xs-injectables-links-module-LifecycleModule-473a63e41d6fffd7c1909f6491334e14a88cba344ad915d67748a96fc9bb2e2b841f8586f1ff08140f22db09df3ad7155c49f4c482bc807abd8692f157c55442"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-LifecycleModule-473a63e41d6fffd7c1909f6491334e14a88cba344ad915d67748a96fc9bb2e2b841f8586f1ff08140f22db09df3ad7155c49f4c482bc807abd8692f157c55442"' :
                                        'id="xs-injectables-links-module-LifecycleModule-473a63e41d6fffd7c1909f6491334e14a88cba344ad915d67748a96fc9bb2e2b841f8586f1ff08140f22db09df3ad7155c49f4c482bc807abd8692f157c55442"' }>
                                        <li class="link">
                                            <a href="injectables/LifecycleService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >LifecycleService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/LpTokensModule.html" data-type="entity-link" >LpTokensModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-LpTokensModule-10a6a811358a6b3d9beecc661b0b630a9cf90252508d917054ee1010be19ed444abbe858c2d8b9b937b40af18b162c0b9101382ca65d453d38caae37eb9186d9"' : 'data-bs-target="#xs-controllers-links-module-LpTokensModule-10a6a811358a6b3d9beecc661b0b630a9cf90252508d917054ee1010be19ed444abbe858c2d8b9b937b40af18b162c0b9101382ca65d453d38caae37eb9186d9"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-LpTokensModule-10a6a811358a6b3d9beecc661b0b630a9cf90252508d917054ee1010be19ed444abbe858c2d8b9b937b40af18b162c0b9101382ca65d453d38caae37eb9186d9"' :
                                            'id="xs-controllers-links-module-LpTokensModule-10a6a811358a6b3d9beecc661b0b630a9cf90252508d917054ee1010be19ed444abbe858c2d8b9b937b40af18b162c0b9101382ca65d453d38caae37eb9186d9"' }>
                                            <li class="link">
                                                <a href="controllers/LpTokensController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >LpTokensController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-LpTokensModule-10a6a811358a6b3d9beecc661b0b630a9cf90252508d917054ee1010be19ed444abbe858c2d8b9b937b40af18b162c0b9101382ca65d453d38caae37eb9186d9"' : 'data-bs-target="#xs-injectables-links-module-LpTokensModule-10a6a811358a6b3d9beecc661b0b630a9cf90252508d917054ee1010be19ed444abbe858c2d8b9b937b40af18b162c0b9101382ca65d453d38caae37eb9186d9"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-LpTokensModule-10a6a811358a6b3d9beecc661b0b630a9cf90252508d917054ee1010be19ed444abbe858c2d8b9b937b40af18b162c0b9101382ca65d453d38caae37eb9186d9"' :
                                        'id="xs-injectables-links-module-LpTokensModule-10a6a811358a6b3d9beecc661b0b630a9cf90252508d917054ee1010be19ed444abbe858c2d8b9b937b40af18b162c0b9101382ca65d453d38caae37eb9186d9"' }>
                                        <li class="link">
                                            <a href="injectables/LpTokensService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >LpTokensService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/TaptoolsModule.html" data-type="entity-link" >TaptoolsModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-TaptoolsModule-17ce3b6bb4376630946d6f6910f192d19459dfb3209eb97312273f6ece587a58d2176f95be391cbd9ffcd4a623a01a22137089facb3b47bf59ede40435a51593"' : 'data-bs-target="#xs-controllers-links-module-TaptoolsModule-17ce3b6bb4376630946d6f6910f192d19459dfb3209eb97312273f6ece587a58d2176f95be391cbd9ffcd4a623a01a22137089facb3b47bf59ede40435a51593"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-TaptoolsModule-17ce3b6bb4376630946d6f6910f192d19459dfb3209eb97312273f6ece587a58d2176f95be391cbd9ffcd4a623a01a22137089facb3b47bf59ede40435a51593"' :
                                            'id="xs-controllers-links-module-TaptoolsModule-17ce3b6bb4376630946d6f6910f192d19459dfb3209eb97312273f6ece587a58d2176f95be391cbd9ffcd4a623a01a22137089facb3b47bf59ede40435a51593"' }>
                                            <li class="link">
                                                <a href="controllers/TaptoolsController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >TaptoolsController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-TaptoolsModule-17ce3b6bb4376630946d6f6910f192d19459dfb3209eb97312273f6ece587a58d2176f95be391cbd9ffcd4a623a01a22137089facb3b47bf59ede40435a51593"' : 'data-bs-target="#xs-injectables-links-module-TaptoolsModule-17ce3b6bb4376630946d6f6910f192d19459dfb3209eb97312273f6ece587a58d2176f95be391cbd9ffcd4a623a01a22137089facb3b47bf59ede40435a51593"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-TaptoolsModule-17ce3b6bb4376630946d6f6910f192d19459dfb3209eb97312273f6ece587a58d2176f95be391cbd9ffcd4a623a01a22137089facb3b47bf59ede40435a51593"' :
                                        'id="xs-injectables-links-module-TaptoolsModule-17ce3b6bb4376630946d6f6910f192d19459dfb3209eb97312273f6ece587a58d2176f95be391cbd9ffcd4a623a01a22137089facb3b47bf59ede40435a51593"' }>
                                        <li class="link">
                                            <a href="injectables/TaptoolsService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >TaptoolsService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/TransactionsModule.html" data-type="entity-link" >TransactionsModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-TransactionsModule-010d736dc6703c45efcfa6cf6bd8030d519e26742d252b3ca5a4a605989725cb69dbc5cf26829f240852530b8e66c0f732975215e87573e185c90926a4d87c7f"' : 'data-bs-target="#xs-controllers-links-module-TransactionsModule-010d736dc6703c45efcfa6cf6bd8030d519e26742d252b3ca5a4a605989725cb69dbc5cf26829f240852530b8e66c0f732975215e87573e185c90926a4d87c7f"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-TransactionsModule-010d736dc6703c45efcfa6cf6bd8030d519e26742d252b3ca5a4a605989725cb69dbc5cf26829f240852530b8e66c0f732975215e87573e185c90926a4d87c7f"' :
                                            'id="xs-controllers-links-module-TransactionsModule-010d736dc6703c45efcfa6cf6bd8030d519e26742d252b3ca5a4a605989725cb69dbc5cf26829f240852530b8e66c0f732975215e87573e185c90926a4d87c7f"' }>
                                            <li class="link">
                                                <a href="controllers/TransactionsController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >TransactionsController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-TransactionsModule-010d736dc6703c45efcfa6cf6bd8030d519e26742d252b3ca5a4a605989725cb69dbc5cf26829f240852530b8e66c0f732975215e87573e185c90926a4d87c7f"' : 'data-bs-target="#xs-injectables-links-module-TransactionsModule-010d736dc6703c45efcfa6cf6bd8030d519e26742d252b3ca5a4a605989725cb69dbc5cf26829f240852530b8e66c0f732975215e87573e185c90926a4d87c7f"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-TransactionsModule-010d736dc6703c45efcfa6cf6bd8030d519e26742d252b3ca5a4a605989725cb69dbc5cf26829f240852530b8e66c0f732975215e87573e185c90926a4d87c7f"' :
                                        'id="xs-injectables-links-module-TransactionsModule-010d736dc6703c45efcfa6cf6bd8030d519e26742d252b3ca5a4a605989725cb69dbc5cf26829f240852530b8e66c0f732975215e87573e185c90926a4d87c7f"' }>
                                        <li class="link">
                                            <a href="injectables/TransactionsService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >TransactionsService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/UsersModule.html" data-type="entity-link" >UsersModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-UsersModule-0af0fa638334aca106494ab680a0c4e2283a1673ed952e2ec8527087923dabadb0026390c1314432ddd1ac2bdbdbb772ce86c13fc270bf23a9274e4edbbab153"' : 'data-bs-target="#xs-controllers-links-module-UsersModule-0af0fa638334aca106494ab680a0c4e2283a1673ed952e2ec8527087923dabadb0026390c1314432ddd1ac2bdbdbb772ce86c13fc270bf23a9274e4edbbab153"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-UsersModule-0af0fa638334aca106494ab680a0c4e2283a1673ed952e2ec8527087923dabadb0026390c1314432ddd1ac2bdbdbb772ce86c13fc270bf23a9274e4edbbab153"' :
                                            'id="xs-controllers-links-module-UsersModule-0af0fa638334aca106494ab680a0c4e2283a1673ed952e2ec8527087923dabadb0026390c1314432ddd1ac2bdbdbb772ce86c13fc270bf23a9274e4edbbab153"' }>
                                            <li class="link">
                                                <a href="controllers/UsersController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >UsersController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-UsersModule-0af0fa638334aca106494ab680a0c4e2283a1673ed952e2ec8527087923dabadb0026390c1314432ddd1ac2bdbdbb772ce86c13fc270bf23a9274e4edbbab153"' : 'data-bs-target="#xs-injectables-links-module-UsersModule-0af0fa638334aca106494ab680a0c4e2283a1673ed952e2ec8527087923dabadb0026390c1314432ddd1ac2bdbdbb772ce86c13fc270bf23a9274e4edbbab153"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-UsersModule-0af0fa638334aca106494ab680a0c4e2283a1673ed952e2ec8527087923dabadb0026390c1314432ddd1ac2bdbdbb772ce86c13fc270bf23a9274e4edbbab153"' :
                                        'id="xs-injectables-links-module-UsersModule-0af0fa638334aca106494ab680a0c4e2283a1673ed952e2ec8527087923dabadb0026390c1314432ddd1ac2bdbdbb772ce86c13fc270bf23a9274e4edbbab153"' }>
                                        <li class="link">
                                            <a href="injectables/UsersService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >UsersService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/VaultsModule.html" data-type="entity-link" >VaultsModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-VaultsModule-bf4777b43dfb49be06fb4041f49524ad698d33622c8817e457d292f19f9c3c610d81670477214578847ddabc749edf56517b523fd06fdc61ecb977e59841f567"' : 'data-bs-target="#xs-controllers-links-module-VaultsModule-bf4777b43dfb49be06fb4041f49524ad698d33622c8817e457d292f19f9c3c610d81670477214578847ddabc749edf56517b523fd06fdc61ecb977e59841f567"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-VaultsModule-bf4777b43dfb49be06fb4041f49524ad698d33622c8817e457d292f19f9c3c610d81670477214578847ddabc749edf56517b523fd06fdc61ecb977e59841f567"' :
                                            'id="xs-controllers-links-module-VaultsModule-bf4777b43dfb49be06fb4041f49524ad698d33622c8817e457d292f19f9c3c610d81670477214578847ddabc749edf56517b523fd06fdc61ecb977e59841f567"' }>
                                            <li class="link">
                                                <a href="controllers/VaultsController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >VaultsController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-VaultsModule-bf4777b43dfb49be06fb4041f49524ad698d33622c8817e457d292f19f9c3c610d81670477214578847ddabc749edf56517b523fd06fdc61ecb977e59841f567"' : 'data-bs-target="#xs-injectables-links-module-VaultsModule-bf4777b43dfb49be06fb4041f49524ad698d33622c8817e457d292f19f9c3c610d81670477214578847ddabc749edf56517b523fd06fdc61ecb977e59841f567"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-VaultsModule-bf4777b43dfb49be06fb4041f49524ad698d33622c8817e457d292f19f9c3c610d81670477214578847ddabc749edf56517b523fd06fdc61ecb977e59841f567"' :
                                        'id="xs-injectables-links-module-VaultsModule-bf4777b43dfb49be06fb4041f49524ad698d33622c8817e457d292f19f9c3c610d81670477214578847ddabc749edf56517b523fd06fdc61ecb977e59841f567"' }>
                                        <li class="link">
                                            <a href="injectables/DraftVaultsService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >DraftVaultsService</a>
                                        </li>
                                        <li class="link">
                                            <a href="injectables/VaultsService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >VaultsService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                            <li class="link">
                                <a href="modules/VyfiModule.html" data-type="entity-link" >VyfiModule</a>
                                    <li class="chapter inner">
                                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                            'data-bs-target="#controllers-links-module-VyfiModule-65fe3f20a5720e4675d55bc49d709fe474613d23fcadc5d39bfb0892e0ddca9c4ee8b1b41ffea4fddde5364e747badb50288c572ab27d42d35983867fff0ab67"' : 'data-bs-target="#xs-controllers-links-module-VyfiModule-65fe3f20a5720e4675d55bc49d709fe474613d23fcadc5d39bfb0892e0ddca9c4ee8b1b41ffea4fddde5364e747badb50288c572ab27d42d35983867fff0ab67"' }>
                                            <span class="icon ion-md-swap"></span>
                                            <span>Controllers</span>
                                            <span class="icon ion-ios-arrow-down"></span>
                                        </div>
                                        <ul class="links collapse" ${ isNormalMode ? 'id="controllers-links-module-VyfiModule-65fe3f20a5720e4675d55bc49d709fe474613d23fcadc5d39bfb0892e0ddca9c4ee8b1b41ffea4fddde5364e747badb50288c572ab27d42d35983867fff0ab67"' :
                                            'id="xs-controllers-links-module-VyfiModule-65fe3f20a5720e4675d55bc49d709fe474613d23fcadc5d39bfb0892e0ddca9c4ee8b1b41ffea4fddde5364e747badb50288c572ab27d42d35983867fff0ab67"' }>
                                            <li class="link">
                                                <a href="controllers/VyfiController.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >VyfiController</a>
                                            </li>
                                        </ul>
                                    </li>
                                <li class="chapter inner">
                                    <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ?
                                        'data-bs-target="#injectables-links-module-VyfiModule-65fe3f20a5720e4675d55bc49d709fe474613d23fcadc5d39bfb0892e0ddca9c4ee8b1b41ffea4fddde5364e747badb50288c572ab27d42d35983867fff0ab67"' : 'data-bs-target="#xs-injectables-links-module-VyfiModule-65fe3f20a5720e4675d55bc49d709fe474613d23fcadc5d39bfb0892e0ddca9c4ee8b1b41ffea4fddde5364e747badb50288c572ab27d42d35983867fff0ab67"' }>
                                        <span class="icon ion-md-arrow-round-down"></span>
                                        <span>Injectables</span>
                                        <span class="icon ion-ios-arrow-down"></span>
                                    </div>
                                    <ul class="links collapse" ${ isNormalMode ? 'id="injectables-links-module-VyfiModule-65fe3f20a5720e4675d55bc49d709fe474613d23fcadc5d39bfb0892e0ddca9c4ee8b1b41ffea4fddde5364e747badb50288c572ab27d42d35983867fff0ab67"' :
                                        'id="xs-injectables-links-module-VyfiModule-65fe3f20a5720e4675d55bc49d709fe474613d23fcadc5d39bfb0892e0ddca9c4ee8b1b41ffea4fddde5364e747badb50288c572ab27d42d35983867fff0ab67"' }>
                                        <li class="link">
                                            <a href="injectables/VyfiService.html" data-type="entity-link" data-context="sub-entity" data-context-id="modules" >VyfiService</a>
                                        </li>
                                    </ul>
                                </li>
                            </li>
                </ul>
                </li>
                        <li class="chapter">
                            <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#controllers-links"' :
                                'data-bs-target="#xs-controllers-links"' }>
                                <span class="icon ion-md-swap"></span>
                                <span>Controllers</span>
                                <span class="icon ion-ios-arrow-down"></span>
                            </div>
                            <ul class="links collapse " ${ isNormalMode ? 'id="controllers-links"' : 'id="xs-controllers-links"' }>
                                <li class="link">
                                    <a href="controllers/AcquireController.html" data-type="entity-link" >AcquireController</a>
                                </li>
                                <li class="link">
                                    <a href="controllers/AppController.html" data-type="entity-link" >AppController</a>
                                </li>
                                <li class="link">
                                    <a href="controllers/AssetsController.html" data-type="entity-link" >AssetsController</a>
                                </li>
                                <li class="link">
                                    <a href="controllers/AuthController.html" data-type="entity-link" >AuthController</a>
                                </li>
                                <li class="link">
                                    <a href="controllers/AwsController.html" data-type="entity-link" >AwsController</a>
                                </li>
                                <li class="link">
                                    <a href="controllers/BlockchainController.html" data-type="entity-link" >BlockchainController</a>
                                </li>
                                <li class="link">
                                    <a href="controllers/ContributionController.html" data-type="entity-link" >ContributionController</a>
                                </li>
                                <li class="link">
                                    <a href="controllers/GovernanceController.html" data-type="entity-link" >GovernanceController</a>
                                </li>
                                <li class="link">
                                    <a href="controllers/LpTokensController.html" data-type="entity-link" >LpTokensController</a>
                                </li>
                                <li class="link">
                                    <a href="controllers/TaptoolsController.html" data-type="entity-link" >TaptoolsController</a>
                                </li>
                                <li class="link">
                                    <a href="controllers/TransactionsController.html" data-type="entity-link" >TransactionsController</a>
                                </li>
                                <li class="link">
                                    <a href="controllers/UsersController.html" data-type="entity-link" >UsersController</a>
                                </li>
                                <li class="link">
                                    <a href="controllers/VaultsController.html" data-type="entity-link" >VaultsController</a>
                                </li>
                                <li class="link">
                                    <a href="controllers/VyfiController.html" data-type="entity-link" >VyfiController</a>
                                </li>
                            </ul>
                        </li>
                        <li class="chapter">
                            <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#entities-links"' :
                                'data-bs-target="#xs-entities-links"' }>
                                <span class="icon ion-ios-apps"></span>
                                <span>Entities</span>
                                <span class="icon ion-ios-arrow-down"></span>
                            </div>
                            <ul class="links collapse " ${ isNormalMode ? 'id="entities-links"' : 'id="xs-entities-links"' }>
                                <li class="link">
                                    <a href="entities/AcquirerWhitelistEntity.html" data-type="entity-link" >AcquirerWhitelistEntity</a>
                                </li>
                                <li class="link">
                                    <a href="entities/Asset.html" data-type="entity-link" >Asset</a>
                                </li>
                                <li class="link">
                                    <a href="entities/AssetsWhitelistEntity.html" data-type="entity-link" >AssetsWhitelistEntity</a>
                                </li>
                                <li class="link">
                                    <a href="entities/ContributorWhitelistEntity.html" data-type="entity-link" >ContributorWhitelistEntity</a>
                                </li>
                                <li class="link">
                                    <a href="entities/FileEntity.html" data-type="entity-link" >FileEntity</a>
                                </li>
                                <li class="link">
                                    <a href="entities/LinkEntity.html" data-type="entity-link" >LinkEntity</a>
                                </li>
                                <li class="link">
                                    <a href="entities/TagEntity.html" data-type="entity-link" >TagEntity</a>
                                </li>
                                <li class="link">
                                    <a href="entities/Transaction.html" data-type="entity-link" >Transaction</a>
                                </li>
                                <li class="link">
                                    <a href="entities/User.html" data-type="entity-link" >User</a>
                                </li>
                                <li class="link">
                                    <a href="entities/Vault.html" data-type="entity-link" >Vault</a>
                                </li>
                            </ul>
                        </li>
                    <li class="chapter">
                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#classes-links"' :
                            'data-bs-target="#xs-classes-links"' }>
                            <span class="icon ion-ios-paper"></span>
                            <span>Classes</span>
                            <span class="icon ion-ios-arrow-down"></span>
                        </div>
                        <ul class="links collapse " ${ isNormalMode ? 'id="classes-links"' : 'id="xs-classes-links"' }>
                            <li class="link">
                                <a href="classes/$npmConfigName1750085776373.html" data-type="entity-link" >$npmConfigName1750085776373</a>
                            </li>
                            <li class="link">
                                <a href="classes/$npmConfigName1750413089611.html" data-type="entity-link" >$npmConfigName1750413089611</a>
                            </li>
                            <li class="link">
                                <a href="classes/AcquireReq.html" data-type="entity-link" >AcquireReq</a>
                            </li>
                            <li class="link">
                                <a href="classes/AcquirerWhitelist.html" data-type="entity-link" >AcquirerWhitelist</a>
                            </li>
                            <li class="link">
                                <a href="classes/AcquirerWhitelistCsv.html" data-type="entity-link" >AcquirerWhitelistCsv</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddContractAddressToVault1745662880319.html" data-type="entity-link" >AddContractAddressToVault1745662880319</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddedAauired1748361017536.html" data-type="entity-link" >AddedAauired1748361017536</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddedAssetsStatus1748264767365.html" data-type="entity-link" >AddedAssetsStatus1748264767365</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddedAssetVaultName1745921850315.html" data-type="entity-link" >AddedAssetVaultName1745921850315</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddedContributorWhitelist1742484041497.html" data-type="entity-link" >AddedContributorWhitelist1742484041497</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddedDelete1747838327085.html" data-type="entity-link" >AddedDelete1747838327085</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddedLiquidationHash1749046550619.html" data-type="entity-link" >AddedLiquidationHash1749046550619</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddedMaxAssetsCount1747911428750.html" data-type="entity-link" >AddedMaxAssetsCount1747911428750</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddedPublicationHash1745583708330.html" data-type="entity-link" >AddedPublicationHash1745583708330</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddedReserveVaule1747821437539.html" data-type="entity-link" >AddedReserveVaule1747821437539</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddedTags1741943808652.html" data-type="entity-link" >AddedTags1741943808652</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddedTransactionModelAndRelations1743588383672.html" data-type="entity-link" >AddedTransactionModelAndRelations1743588383672</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddIndexToTransaction1744024797075.html" data-type="entity-link" >AddIndexToTransaction1744024797075</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddInvestmentToTxType1744032453542.html" data-type="entity-link" >AddInvestmentToTxType1744032453542</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddNullableForMetadata1743687086047.html" data-type="entity-link" >AddNullableForMetadata1743687086047</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddStakeAndWalletAddress1743433439139.html" data-type="entity-link" >AddStakeAndWalletAddress1743433439139</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddTotalAcquiredValueInAda1750670509513.html" data-type="entity-link" >AddTotalAcquiredValueInAda1750670509513</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddTotalAssetsCost1747665618438.html" data-type="entity-link" >AddTotalAssetsCost1747665618438</a>
                            </li>
                            <li class="link">
                                <a href="classes/AddVaultLifecycleFields1741943808653.html" data-type="entity-link" >AddVaultLifecycleFields1741943808653</a>
                            </li>
                            <li class="link">
                                <a href="classes/AssetMetadataDto.html" data-type="entity-link" >AssetMetadataDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/AssetValueDto.html" data-type="entity-link" >AssetValueDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/AssetWhitelist.html" data-type="entity-link" >AssetWhitelist</a>
                            </li>
                            <li class="link">
                                <a href="classes/AssetWhitelistDto.html" data-type="entity-link" >AssetWhitelistDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/BlockchainWebhookDto.html" data-type="entity-link" >BlockchainWebhookDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/BlockfrostAmount.html" data-type="entity-link" >BlockfrostAmount</a>
                            </li>
                            <li class="link">
                                <a href="classes/BlockfrostTransaction.html" data-type="entity-link" >BlockfrostTransaction</a>
                            </li>
                            <li class="link">
                                <a href="classes/BlockfrostTransactionEvent.html" data-type="entity-link" >BlockfrostTransactionEvent</a>
                            </li>
                            <li class="link">
                                <a href="classes/BlockfrostTxInput.html" data-type="entity-link" >BlockfrostTxInput</a>
                            </li>
                            <li class="link">
                                <a href="classes/BlockfrostTxOutput.html" data-type="entity-link" >BlockfrostTxOutput</a>
                            </li>
                            <li class="link">
                                <a href="classes/BuildTransactionDto.html" data-type="entity-link" >BuildTransactionDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/ChangeAssetsOwnerType1743678745097.html" data-type="entity-link" >ChangeAssetsOwnerType1743678745097</a>
                            </li>
                            <li class="link">
                                <a href="classes/ChangeIntervalToBigint1742311345554.html" data-type="entity-link" >ChangeIntervalToBigint1742311345554</a>
                            </li>
                            <li class="link">
                                <a href="classes/ContributeReq.html" data-type="entity-link" >ContributeReq</a>
                            </li>
                            <li class="link">
                                <a href="classes/ContributionAsset.html" data-type="entity-link" >ContributionAsset</a>
                            </li>
                            <li class="link">
                                <a href="classes/ContributorWhitelist.html" data-type="entity-link" >ContributorWhitelist</a>
                            </li>
                            <li class="link">
                                <a href="classes/CreateAssetDto.html" data-type="entity-link" >CreateAssetDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/CreatePoolDto.html" data-type="entity-link" >CreatePoolDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/CreateProposalReq.html" data-type="entity-link" >CreateProposalReq</a>
                            </li>
                            <li class="link">
                                <a href="classes/CreateVaultReq.html" data-type="entity-link" >CreateVaultReq</a>
                            </li>
                            <li class="link">
                                <a href="classes/DatabaseStruct1741879378411.html" data-type="entity-link" >DatabaseStruct1741879378411</a>
                            </li>
                            <li class="link">
                                <a href="classes/DropOldVauleFormEnum1742800589634.html" data-type="entity-link" >DropOldVauleFormEnum1742800589634</a>
                            </li>
                            <li class="link">
                                <a href="classes/ExtractLpTokensDto.html" data-type="entity-link" >ExtractLpTokensDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/GetVaultsDto.html" data-type="entity-link" >GetVaultsDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/GetVaultTransactionsDto.html" data-type="entity-link" >GetVaultTransactionsDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/LoginReq.html" data-type="entity-link" >LoginReq</a>
                            </li>
                            <li class="link">
                                <a href="classes/LpTokenOperationResult.html" data-type="entity-link" >LpTokenOperationResult</a>
                            </li>
                            <li class="link">
                                <a href="classes/MetadataFile.html" data-type="entity-link" >MetadataFile</a>
                            </li>
                            <li class="link">
                                <a href="classes/NftAsset.html" data-type="entity-link" >NftAsset</a>
                            </li>
                            <li class="link">
                                <a href="classes/OnchainMetadata.html" data-type="entity-link" >OnchainMetadata</a>
                            </li>
                            <li class="link">
                                <a href="classes/PaginatedResponseDto.html" data-type="entity-link" >PaginatedResponseDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/PaginationDto.html" data-type="entity-link" >PaginationDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/PolicyId1749726859213.html" data-type="entity-link" >PolicyId1749726859213</a>
                            </li>
                            <li class="link">
                                <a href="classes/PolicyIdRestore1749727852748.html" data-type="entity-link" >PolicyIdRestore1749727852748</a>
                            </li>
                            <li class="link">
                                <a href="classes/PublicProfileRes.html" data-type="entity-link" >PublicProfileRes</a>
                            </li>
                            <li class="link">
                                <a href="classes/PublishVaultDto.html" data-type="entity-link" >PublishVaultDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/RenameFieldFixEnum1742800375799.html" data-type="entity-link" >RenameFieldFixEnum1742800375799</a>
                            </li>
                            <li class="link">
                                <a href="classes/RenameFields1746536544579.html" data-type="entity-link" >RenameFields1746536544579</a>
                            </li>
                            <li class="link">
                                <a href="classes/RenameInvestmentToAcquire1746531791148.html" data-type="entity-link" >RenameInvestmentToAcquire1746531791148</a>
                            </li>
                            <li class="link">
                                <a href="classes/RenameVaultField1742382533813.html" data-type="entity-link" >RenameVaultField1742382533813</a>
                            </li>
                            <li class="link">
                                <a href="classes/ReplaceLockedStateToGovernance1743424803837.html" data-type="entity-link" >ReplaceLockedStateToGovernance1743424803837</a>
                            </li>
                            <li class="link">
                                <a href="classes/SaveDraftReq.html" data-type="entity-link" >SaveDraftReq</a>
                            </li>
                            <li class="link">
                                <a href="classes/SignatureData.html" data-type="entity-link" >SignatureData</a>
                            </li>
                            <li class="link">
                                <a href="classes/SocialLink.html" data-type="entity-link" >SocialLink</a>
                            </li>
                            <li class="link">
                                <a href="classes/SocialLinkDto.html" data-type="entity-link" >SocialLinkDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/SubmitTransactionDto.html" data-type="entity-link" >SubmitTransactionDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/SubmitVaultTxDto.html" data-type="entity-link" >SubmitVaultTxDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/TagDto.html" data-type="entity-link" >TagDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/TokenInfo.html" data-type="entity-link" >TokenInfo</a>
                            </li>
                            <li class="link">
                                <a href="classes/TransactionBuildResponseDto.html" data-type="entity-link" >TransactionBuildResponseDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/TransactionModelFix1743089378621.html" data-type="entity-link" >TransactionModelFix1743089378621</a>
                            </li>
                            <li class="link">
                                <a href="classes/TransactionOutput.html" data-type="entity-link" >TransactionOutput</a>
                            </li>
                            <li class="link">
                                <a href="classes/TransactionSubmitResponseDto.html" data-type="entity-link" >TransactionSubmitResponseDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/TxUpdateReq.html" data-type="entity-link" >TxUpdateReq</a>
                            </li>
                            <li class="link">
                                <a href="classes/UpdateFieldsType1741946649594.html" data-type="entity-link" >UpdateFieldsType1741946649594</a>
                            </li>
                            <li class="link">
                                <a href="classes/UpdateProfileDto.html" data-type="entity-link" >UpdateProfileDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/UpdateRelationto1742209228422.html" data-type="entity-link" >UpdateRelationto1742209228422</a>
                            </li>
                            <li class="link">
                                <a href="classes/UpdateType1742819100112.html" data-type="entity-link" >UpdateType1742819100112</a>
                            </li>
                            <li class="link">
                                <a href="classes/UpdateTypes1746532933340.html" data-type="entity-link" >UpdateTypes1746532933340</a>
                            </li>
                            <li class="link">
                                <a href="classes/UploadImageDto.html" data-type="entity-link" >UploadImageDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/VaultAssetsSummaryDto.html" data-type="entity-link" >VaultAssetsSummaryDto</a>
                            </li>
                            <li class="link">
                                <a href="classes/VaultFullResponse.html" data-type="entity-link" >VaultFullResponse</a>
                            </li>
                            <li class="link">
                                <a href="classes/VaultShortResponse.html" data-type="entity-link" >VaultShortResponse</a>
                            </li>
                            <li class="link">
                                <a href="classes/VaultStatusUpdate1745573712493.html" data-type="entity-link" >VaultStatusUpdate1745573712493</a>
                            </li>
                            <li class="link">
                                <a href="classes/VoteReq.html" data-type="entity-link" >VoteReq</a>
                            </li>
                            <li class="link">
                                <a href="classes/WalletSummaryDto.html" data-type="entity-link" >WalletSummaryDto</a>
                            </li>
                        </ul>
                    </li>
                        <li class="chapter">
                            <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#injectables-links"' :
                                'data-bs-target="#xs-injectables-links"' }>
                                <span class="icon ion-md-arrow-round-down"></span>
                                <span>Injectables</span>
                                <span class="icon ion-ios-arrow-down"></span>
                            </div>
                            <ul class="links collapse " ${ isNormalMode ? 'id="injectables-links"' : 'id="xs-injectables-links"' }>
                                <li class="link">
                                    <a href="injectables/AcquireService.html" data-type="entity-link" >AcquireService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/AnvilApiService.html" data-type="entity-link" >AnvilApiService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/AppService.html" data-type="entity-link" >AppService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/AssetsService.html" data-type="entity-link" >AssetsService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/AuthService.html" data-type="entity-link" >AuthService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/AwsService.html" data-type="entity-link" >AwsService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/BlockchainScannerService.html" data-type="entity-link" >BlockchainScannerService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/BlockchainService.html" data-type="entity-link" >BlockchainService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/ContributionService.html" data-type="entity-link" >ContributionService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/DistributionService.html" data-type="entity-link" >DistributionService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/DraftVaultsService.html" data-type="entity-link" >DraftVaultsService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/GovernanceService.html" data-type="entity-link" >GovernanceService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/LifecycleService.html" data-type="entity-link" >LifecycleService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/LpTokensService.html" data-type="entity-link" >LpTokensService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/RawBodyMiddleware.html" data-type="entity-link" >RawBodyMiddleware</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/TaptoolsService.html" data-type="entity-link" >TaptoolsService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/TransactionsService.html" data-type="entity-link" >TransactionsService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/UsersService.html" data-type="entity-link" >UsersService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/VaultInsertingService.html" data-type="entity-link" >VaultInsertingService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/VaultManagingService.html" data-type="entity-link" >VaultManagingService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/VaultsService.html" data-type="entity-link" >VaultsService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/VyfiService.html" data-type="entity-link" >VyfiService</a>
                                </li>
                                <li class="link">
                                    <a href="injectables/WebhookVerificationService.html" data-type="entity-link" >WebhookVerificationService</a>
                                </li>
                            </ul>
                        </li>
                    <li class="chapter">
                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#guards-links"' :
                            'data-bs-target="#xs-guards-links"' }>
                            <span class="icon ion-ios-lock"></span>
                            <span>Guards</span>
                            <span class="icon ion-ios-arrow-down"></span>
                        </div>
                        <ul class="links collapse " ${ isNormalMode ? 'id="guards-links"' : 'id="xs-guards-links"' }>
                            <li class="link">
                                <a href="guards/AuthGuard.html" data-type="entity-link" >AuthGuard</a>
                            </li>
                        </ul>
                    </li>
                    <li class="chapter">
                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#interfaces-links"' :
                            'data-bs-target="#xs-interfaces-links"' }>
                            <span class="icon ion-md-information-circle-outline"></span>
                            <span>Interfaces</span>
                            <span class="icon ion-ios-arrow-down"></span>
                        </div>
                        <ul class="links collapse " ${ isNormalMode ? ' id="interfaces-links"' : 'id="xs-interfaces-links"' }>
                            <li class="link">
                                <a href="interfaces/Amount.html" data-type="entity-link" >Amount</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/AnvilApiConfig.html" data-type="entity-link" >AnvilApiConfig</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/ApiDocParams.html" data-type="entity-link" >ApiDocParams</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/Asset.html" data-type="entity-link" >Asset</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/BlockchainAddressResponse.html" data-type="entity-link" >BlockchainAddressResponse</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/BlockchainContractResponse.html" data-type="entity-link" >BlockchainContractResponse</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/BlockchainTokenResponse.html" data-type="entity-link" >BlockchainTokenResponse</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/BlockchainTransactionListItem.html" data-type="entity-link" >BlockchainTransactionListItem</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/BlockchainTransactionListResponse.html" data-type="entity-link" >BlockchainTransactionListResponse</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/BlockchainTransactionResponse.html" data-type="entity-link" >BlockchainTransactionResponse</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/BlockchainUtxo.html" data-type="entity-link" >BlockchainUtxo</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/BuildTransactionOutput.html" data-type="entity-link" >BuildTransactionOutput</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/BuildTransactionParams.html" data-type="entity-link" >BuildTransactionParams</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/BuildTransactionParams-1.html" data-type="entity-link" >BuildTransactionParams</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/BurnLpTokensParams.html" data-type="entity-link" >BurnLpTokensParams</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/Datum.html" data-type="entity-link" >Datum</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/Datum1.html" data-type="entity-link" >Datum1</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/DistributeLpTokensParams.html" data-type="entity-link" >DistributeLpTokensParams</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/DtoRepresentsType.html" data-type="entity-link" >DtoRepresentsType</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/ExtractLpTokensParams.html" data-type="entity-link" >ExtractLpTokensParams</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/ExtractLpTokensParams-1.html" data-type="entity-link" >ExtractLpTokensParams</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/L4VaVault.html" data-type="entity-link" >L4VaVault</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/LpTokenOperationResult.html" data-type="entity-link" >LpTokenOperationResult</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/NftAsset.html" data-type="entity-link" >NftAsset</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/SubmitTransactionParams.html" data-type="entity-link" >SubmitTransactionParams</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/TransactionBuildResponse.html" data-type="entity-link" >TransactionBuildResponse</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/TransactionBuildResponse-1.html" data-type="entity-link" >TransactionBuildResponse</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/TransactionBuildResponse-2.html" data-type="entity-link" >TransactionBuildResponse</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/TransactionSubmitResponse.html" data-type="entity-link" >TransactionSubmitResponse</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/TransactionSubmitResponse-1.html" data-type="entity-link" >TransactionSubmitResponse</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/VaultConfig.html" data-type="entity-link" >VaultConfig</a>
                            </li>
                            <li class="link">
                                <a href="interfaces/VaultCreateConfig.html" data-type="entity-link" >VaultCreateConfig</a>
                            </li>
                        </ul>
                    </li>
                    <li class="chapter">
                        <div class="simple menu-toggler" data-bs-toggle="collapse" ${ isNormalMode ? 'data-bs-target="#miscellaneous-links"'
                            : 'data-bs-target="#xs-miscellaneous-links"' }>
                            <span class="icon ion-ios-cube"></span>
                            <span>Miscellaneous</span>
                            <span class="icon ion-ios-arrow-down"></span>
                        </div>
                        <ul class="links collapse " ${ isNormalMode ? 'id="miscellaneous-links"' : 'id="xs-miscellaneous-links"' }>
                            <li class="link">
                                <a href="miscellaneous/enumerations.html" data-type="entity-link">Enums</a>
                            </li>
                            <li class="link">
                                <a href="miscellaneous/functions.html" data-type="entity-link">Functions</a>
                            </li>
                            <li class="link">
                                <a href="miscellaneous/typealiases.html" data-type="entity-link">Type aliases</a>
                            </li>
                            <li class="link">
                                <a href="miscellaneous/variables.html" data-type="entity-link">Variables</a>
                            </li>
                        </ul>
                    </li>
                    <li class="chapter">
                        <a data-type="chapter-link" href="coverage.html"><span class="icon ion-ios-stats"></span>Documentation coverage</a>
                    </li>
                    <li class="divider"></li>
                    <li class="copyright">
                        Documentation generated using <a href="https://compodoc.app/" target="_blank" rel="noopener noreferrer">
                            <img data-src="images/compodoc-vectorise.png" class="img-responsive" data-type="compodoc-logo">
                        </a>
                    </li>
            </ul>
        </nav>
        `);
        this.innerHTML = tp.strings;
    }
});