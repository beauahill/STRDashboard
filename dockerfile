# ...your existing app build steps...

# Debian/Ubuntu base:
RUN curl -fsSL https://tailscale.com/install.sh | sh
# (Alpine base instead: RUN apk add --no-cache tailscale)

COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]
