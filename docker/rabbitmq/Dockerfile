# RabbitMQ WITH rabbitmq_delayed_message_exchange.
#
# The official image does NOT bundle this plugin. Without it, declaring an
# x-delayed-message exchange fails and the per-job-type retry ladder silently
# degrades to immediate redelivery — a hot loop against SdI.
#
# NOTE: run plugin installation as root, then restore the rabbitmq user.
# Leaving the image as root breaks /var/lib/rabbitmq/.erlang.cookie
# permissions and the broker dies at boot with "eacces".
FROM rabbitmq:3.13-management

ARG PLUGIN_VERSION=3.13.0
ARG PLUGIN_URL=https://github.com/rabbitmq/rabbitmq-delayed-message-exchange/releases/download/v${PLUGIN_VERSION}/rabbitmq_delayed_message_exchange-${PLUGIN_VERSION}.ez

USER root
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates; \
    curl -fsSL -o "$RABBITMQ_HOME/plugins/rabbitmq_delayed_message_exchange.ez" "${PLUGIN_URL}"; \
    chown rabbitmq:rabbitmq "$RABBITMQ_HOME/plugins/rabbitmq_delayed_message_exchange.ez"; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*; \
    rabbitmq-plugins enable --offline rabbitmq_delayed_message_exchange

USER rabbitmq
