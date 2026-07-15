${API_DOMAIN} {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}

${STREAM_DOMAIN} {
    encode gzip

    handle /api/* {
        reverse_proxy 127.0.0.1:3000
    }

    handle /live/* {
        reverse_proxy 127.0.0.1:8889
    }

    handle {
        root * /srv/www
        file_server
    }
}
