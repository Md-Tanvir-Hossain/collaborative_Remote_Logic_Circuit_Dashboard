FROM php:8.3-cli

WORKDIR /app
COPY . .

RUN apt-get update && apt-get install -y unzip git \
    && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer \
    && composer install --no-dev --optimize-autoloader

EXPOSE 10000
CMD php -S 0.0.0.0:$PORT -t public