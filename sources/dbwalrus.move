module dbwalrus::dbwalrus {
    use sui::object::{Self, UID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use std::string::{Self, String};
    use std::vector;
    use std::option::{Self, Option};

    public struct BlobRegistry has key, store {
        id: UID,
        owner: address,
        blobs: vector<BlobInfo>,
        total_storage_used: u64,
    }

    public struct BlobInfo has store, copy, drop {
        blob_id: u256,
        name: String,
        size: u64,
        content_type: String,
        upload_epoch: u64,
        is_public: bool,
        access_url: String,
    }

    public struct BlobUploadedEvent has copy, drop {
        blob_id: u256,
        owner: address,
        name: String,
        size: u64,
        access_url: String,
        timestamp: u64,
    }

    public struct BlobAccessEvent has copy, drop {
        blob_id: u256,
        accessor: address,
        timestamp: u64,
    }

    const E_NOT_OWNER: u64 = 1;
    const E_BLOB_NOT_FOUND: u64 = 2;
    const E_INVALID_BLOB_SIZE: u64 = 3;
    const E_EMPTY_NAME: u64 = 4;

    public fun create_registry(ctx: &mut TxContext): BlobRegistry {
        BlobRegistry {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            blobs: vector::empty(),
            total_storage_used: 0,
        }
    }

    public fun init_registry(ctx: &mut TxContext) {
        let registry = create_registry(ctx);
        transfer::share_object(registry);
    }

    public entry fun register_blob(
        registry: &mut BlobRegistry,
        blob_id: u256,
        name: vector<u8>,
        size: u64,
        content_type: vector<u8>,
        is_public: bool,
        ctx: &mut TxContext
    ) {
        assert!(vector::length(&name) > 0, E_EMPTY_NAME);
        assert!(size > 0, E_INVALID_BLOB_SIZE);
        
        let sender = tx_context::sender(ctx);
        let epoch = tx_context::epoch(ctx);
        
        let blob_name = string::utf8(name);
        let blob_content_type = string::utf8(content_type);
        
        let access_url = if (is_public) {
            string::utf8(b"https://aggregator.walrus-testnet.walrus.space/v1/")
        } else {
            string::utf8(b"private://")
        };
        string::append(&mut access_url, u256_to_string(blob_id));
        
        let blob_info = BlobInfo {
            blob_id,
            name: blob_name,
            size,
            content_type: blob_content_type,
            upload_epoch: epoch,
            is_public,
            access_url,
        };
        
        vector::push_back(&mut registry.blobs, blob_info);
        registry.total_storage_used = registry.total_storage_used + size;
        
        event::emit(BlobUploadedEvent {
            blob_id,
            owner: sender,
            name: blob_name,
            size,
            access_url,
            timestamp: epoch,
        });
    }

    public fun get_blob_info(registry: &BlobRegistry, blob_id: u256): Option<BlobInfo> {
        let i = 0;
        let len = vector::length(&registry.blobs);
        
        while (i < len) {
            let blob = vector::borrow(&registry.blobs, i);
            if (blob.blob_id == blob_id) {
                return option::some(*blob)
            };
            i = i + 1;
        };
        
        option::none()
    }

    public fun get_access_url(registry: &BlobRegistry, blob_id: u256): Option<String> {
        let blob_info_opt = get_blob_info(registry, blob_id);
        if (option::is_some(&blob_info_opt)) {
            let blob_info = option::extract(&mut blob_info_opt);
            option::some(blob_info.access_url)
        } else {
            option::none()
        }
    }

    public entry fun access_blob(
        registry: &BlobRegistry,
        blob_id: u256,
        ctx: &mut TxContext
    ) {
        let blob_info_opt = get_blob_info(registry, blob_id);
        assert!(option::is_some(&blob_info_opt), E_BLOB_NOT_FOUND);
        
        let blob_info = option::extract(&mut blob_info_opt);
        assert!(blob_info.is_public, E_NOT_OWNER);
        
        event::emit(BlobAccessEvent {
            blob_id,
            accessor: tx_context::sender(ctx),
            timestamp: tx_context::epoch(ctx),
        });
    }

    public fun get_all_blobs(registry: &BlobRegistry): vector<BlobInfo> {
        registry.blobs
    }

    public fun get_total_storage_used(registry: &BlobRegistry): u64 {
        registry.total_storage_used
    }

    public fun get_blob_count(registry: &BlobRegistry): u64 {
        vector::length(&registry.blobs)
    }

    fun u256_to_string(value: u256): String {
        if (value == 0) {
            return string::utf8(b"0")
        };
        
        let digits = vector::empty<u8>();
        let temp = value;
        
        while (temp > 0) {
            let digit = ((temp % 10) as u8) + 48;
            vector::push_back(&mut digits, digit);
            temp = temp / 10;
        };
        
        vector::reverse(&mut digits);
        string::utf8(digits)
    }
}


