export namespace nacos {
	
	export class ConfigItem {
	    dataId: string;
	    group: string;
	    content: string;
	    configType: string;
	
	    static createFrom(source: any = {}) {
	        return new ConfigItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.dataId = source["dataId"];
	        this.group = source["group"];
	        this.content = source["content"];
	        this.configType = source["configType"];
	    }
	}
	export class ConfigPage {
	    totalCount: number;
	    pageNumber: number;
	    pagesAvailable: number;
	    pageItems: ConfigItem[];
	
	    static createFrom(source: any = {}) {
	        return new ConfigPage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.totalCount = source["totalCount"];
	        this.pageNumber = source["pageNumber"];
	        this.pagesAvailable = source["pagesAvailable"];
	        this.pageItems = this.convertValues(source["pageItems"], ConfigItem);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class HistoryDetail {
	    id: string;
	    dataId: string;
	    group: string;
	    content: string;
	    opType: string;
	    createdTime: string;
	    lastModifiedTime: string;
	
	    static createFrom(source: any = {}) {
	        return new HistoryDetail(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.dataId = source["dataId"];
	        this.group = source["group"];
	        this.content = source["content"];
	        this.opType = source["opType"];
	        this.createdTime = source["createdTime"];
	        this.lastModifiedTime = source["lastModifiedTime"];
	    }
	}
	export class HistoryItem {
	    id: string;
	    dataId: string;
	    group: string;
	    opType: string;
	    lastModifiedTime: string;
	
	    static createFrom(source: any = {}) {
	        return new HistoryItem(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.dataId = source["dataId"];
	        this.group = source["group"];
	        this.opType = source["opType"];
	        this.lastModifiedTime = source["lastModifiedTime"];
	    }
	}
	export class HistoryPage {
	    totalCount: number;
	    pageNumber: number;
	    pagesAvailable: number;
	    pageItems: HistoryItem[];
	
	    static createFrom(source: any = {}) {
	        return new HistoryPage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.totalCount = source["totalCount"];
	        this.pageNumber = source["pageNumber"];
	        this.pagesAvailable = source["pagesAvailable"];
	        this.pageItems = this.convertValues(source["pageItems"], HistoryItem);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LoginResult {
	    accessToken: string;
	    tokenTtl: number;
	    globalAdmin: boolean;
	
	    static createFrom(source: any = {}) {
	        return new LoginResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.accessToken = source["accessToken"];
	        this.tokenTtl = source["tokenTtl"];
	        this.globalAdmin = source["globalAdmin"];
	    }
	}
	export class Namespace {
	    namespace: string;
	    namespaceShowName: string;
	    configCount: number;
	    kind: number;
	
	    static createFrom(source: any = {}) {
	        return new Namespace(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.namespace = source["namespace"];
	        this.namespaceShowName = source["namespaceShowName"];
	        this.configCount = source["configCount"];
	        this.kind = source["kind"];
	    }
	}

}

